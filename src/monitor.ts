// monitor.ts – ONE single file for the entire pipeline
// --------------------------------------------------------
// npm i axios gamedig node-fetch@3 p-limit dotenv
// npm i -D ts-node typescript @types/node
//
// env:
//   STEAM_KEY          – Steam Web API key (IGameServersService)
//   DISCORD_WEBHOOK    – Discord Webhook URL
//   CHUNK              – (optional) how many servers to process per run (default 500)
//   CONCURRENCY        – (optional) concurrent UDP requests (default 150)
// --------------------------------------------------------

import 'dotenv/config';
import fetch from "node-fetch";
import axios from "axios";
import gamedig from "gamedig";
import pLimit from "p-limit";
import { promises as fsPromises, createWriteStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as puppeteer from 'puppeteer';
import https from 'https';
import { URL } from 'url';

// ─────────────────────────── util ────────────────────────────
function sha1(data: Buffer | string) {
  return crypto.createHash("sha1").update(data).digest("hex");
}

// ─────────────────────── ENV / constants ─────────────────────
const STEAM_KEY  = process.env.STEAM_KEY;
const HOOK       = process.env.DISCORD_WEBHOOK;
if (!STEAM_KEY)  throw new Error("STEAM_KEY env missing");
if (!HOOK)       throw new Error("DISCORD_WEBHOOK env missing");

const MAX_SERVERS  = 20_000;
const CHUNK        = Number(process.env.CHUNK ?? 500);
const CONCURRENCY  = Number(process.env.CONCURRENCY ?? 10);
const MAX_RETRIES  = 3;

// ──────────────────────── paths / cache ──────────────────────
const dataDir   = path.resolve("data");
const mapsJson  = path.join(dataDir, "maps.json");
const mapsDir   = path.resolve("maps");

// Initialize directories
const init = async () => {
  await fsPromises.mkdir(dataDir, { recursive: true });
  await fsPromises.mkdir(mapsDir, { recursive: true });
};

interface Cache {
  downloadedFileUrls: string[];
  totalFilesDownloaded: number;
  failedUrls: { url: string; error: string; timestamp: string }[];
}

async function loadCache(): Promise<Cache> {
  try {
    return JSON.parse(await fsPromises.readFile(mapsJson, "utf8"));
  } catch {
    return {
      downloadedFileUrls: [],
      totalFilesDownloaded: 0,
      failedUrls: []
    };
  }
}

async function saveCache(c: Cache) {
  await fsPromises.writeFile(mapsJson, JSON.stringify(c, null, 2));
}

// ─────────────────── Steam master list fetch ─────────────────
async function fetchServers() {
  const params = new URLSearchParams({ key: STEAM_KEY!, filter: "\\appid\\252490", limit: MAX_SERVERS.toString() });
  const url    = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?${params}`;
  const res    = await fetch(url); if (!res.ok) throw new Error("Steam API error: "+res.status);
  const json   = await res.json() as { response: { servers: { addr: string }[] } };
  return json.response.servers.map(s => s.addr);
}

// ──────────────── A2S_RULES helper via gamedig ───────────────
async function getRules(ip: string, port: number, timeout = 4000): Promise<any> {
  const data = await gamedig.query({
    type: "rust", host: ip, port,
    requestRules: true, skipInfo: false, skipPlayers: false,
    givenPortOnly: true, udpTimeout: timeout, socketTimeout: timeout, maxAttempts: 1,
  });
  return data;
}

function pickLevelUrl(dict: Record<string,string>) {
  for (const [k,v] of Object.entries(dict))
    if (k.toLowerCase().includes("levelurl") && v.startsWith("http")) return v;
  return null;
}

// ─────────────────────────── map tags ────────────────────────────
function generateTags(fileName: string): string[] {
  const tags = new Set<string>();
  
  // Remove file extension if it exists
  const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");

  // Split by all potential delimiters
  const parts = nameWithoutExt.split(/[_. -]/).filter(Boolean);

  // Add all individual parts as tags
  parts.forEach(part => tags.add(part));

  // Generate combinations of consecutive parts
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j <= parts.length; j++) {
      const combination = parts.slice(i, j).join('_'); // Combine with '_' or as desired
      tags.add(combination);
    }
  }

  // Additional logic for splitting PusuRust -> Pusu, Rust
  parts.forEach(part => {
    if (part.toLowerCase().includes('rust') && part.length > 4) {
      if (part.toLowerCase().startsWith('pusu')) {
        tags.add('Pusu');
        tags.add('Rust');
      }
    }
  });

  return Array.from(tags).sort();
}

// ─────────────────────── download map ───────────────────────
async function downloadMap(url: string, sharedBrowser?: puppeteer.Browser) {
  const fileName = path.basename(url.split('?')[0]);
  const local    = path.join(mapsDir, fileName);

  // Если это Dropbox — используем прямое скачивание
  if (url.includes('dropbox.com')) {
    let retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        await new Promise<void>((resolve, reject) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Download timeout'));
          }, 60000); // 60 second timeout

          function downloadFile(u: string, dest: string, maxRedirects = 5) {
            const req = https.get(u, { signal: controller.signal }, response => {
              if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                if (maxRedirects === 0) return reject(new Error('Too many redirects'));
                const redirectUrl = new URL(response.headers.location, u).toString();
                response.destroy();
                downloadFile(redirectUrl, dest, maxRedirects - 1);
                return;
              }
              if (response.statusCode !== 200) return reject(new Error(`Failed to get '${u}' (${response.statusCode})`));
              const file = createWriteStream(dest);
              response.pipe(file);
              file.on('finish', () => { 
                clearTimeout(timeout);
                file.close(); 
                resolve(); 
              });
              file.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
              });
            });
            req.on('error', err => {
              clearTimeout(timeout);
              reject(err);
            });
          }
          downloadFile(url, local);
        });
        const mapBuffer = await fsPromises.readFile(local);
        console.log(`(Dropbox) Successfully downloaded map from ${url}`);
        return { buffer: mapBuffer, fileName };
      } catch (error) {
        retries++;
        if (retries === MAX_RETRIES) throw error;
        console.log(`Retry ${retries}/${MAX_RETRIES} for ${url}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
  }

  // Обычное скачивание через Puppeteer
  let browser = sharedBrowser;
  let ownBrowser = false;
  let page;
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      // Если браузер не передан, создаем новый
      if (!browser) {
        browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080',
            '--js-flags="--max-old-space-size=512"',
          ]
        });
        ownBrowser = true;
      }

      page = await browser.newPage();
      
      // Set User-Agent like a real browser
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Set additional headers
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      });

      // First, load the main page of the site
      const baseUrl = new URL(url).origin;
      console.log(`Loading base page ${baseUrl}...`);
      
      // Add timeout for page load
      const pageLoadPromise = page.goto(baseUrl, { 
        waitUntil: 'networkidle0',
        timeout: 60000 // Increased timeout to 60 seconds
      });
      
      const pageLoadTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Page load timeout')), 60000);
      });
      
      await Promise.race([pageLoadPromise, pageLoadTimeout]);

      // Add a random delay
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));

      // Now use page.evaluate to perform a fetch request
      console.log(`Downloading map from ${url}...`);
      const result = await page.evaluate(async (mapUrl) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

          const response = await fetch(mapUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/octet-stream,application/x-msdownload,application/x-download,application/download,*/*',
              'Referer': new URL(mapUrl).origin,
              'Origin': new URL(mapUrl).origin
            },
            signal: controller.signal
          });

          clearTimeout(timeout);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          return Array.from(new Uint8Array(arrayBuffer));
        } catch (error) {
          console.error('Fetch error:', error);
          throw error;
        }
      }, url);

      if (!result || !Array.isArray(result)) {
        throw new Error(`Failed to download map file from ${url}: Invalid response`);
      }

      const mapBuffer = Buffer.from(result);
      await fsPromises.writeFile(local, mapBuffer);
      console.log(`Successfully downloaded map from ${url}`);
      
      // Закрываем только страницу, браузер оставляем открытым если он общий
      await page.close();
      
      return { buffer: mapBuffer, fileName };
    } catch (error) {
      // Закрываем страницу при ошибке
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.error('Error closing page:', e);
        }
      }
      
      retries++;
      if (retries === MAX_RETRIES) {
        if (error instanceof Error) {
          if (error.name === 'TargetCloseError') {
            console.error(`Puppeteer Target closed unexpectedly for ${url}:`, error.message);
          } else {
            console.error(`Puppeteer download error for ${url}:`, error.message);
          }
        } else {
          console.error(`Puppeteer download error for ${url}:`, error);
        }
        throw error;
      }
      console.log(`Retry ${retries}/${MAX_RETRIES} for ${url}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * retries)); // Exponential backoff
    } finally {
      // Закрываем браузер только если мы его создали
      if (ownBrowser && browser) {
        try {
          await browser.close();
        } catch (error) {
          console.error('Error closing browser:', error);
        }
        if (global.gc) {
          global.gc();
        }
      }
    }
  }
}

// ─────────────────────── upload to Facepunch ────────────────────
async function uploadToFacepunch(buffer: Buffer, fileName: string) {
  const url = `https://api.facepunch.com/api/public/rust-map-upload/${fileName}`;
  
  console.log(`Uploading map: ${fileName}`);
  console.log(`Buffer size: ${buffer.length} bytes`);
  console.log(`Buffer SHA1: ${sha1(buffer)}`);
  console.log(`Buffer head: ${buffer.toString('hex', 0, Math.min(buffer.length, 16))}`);
  console.log(`Buffer tail: ${buffer.toString('hex', Math.max(0, buffer.length - 16), buffer.length)}`);

  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.put(url, buffer, {
        headers: {
          "Content-Type": "application/octet-stream"
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 60_000
      });

      if (res.status >= 200 && res.status < 300 && typeof res.data === "string" && res.data.startsWith("http")) {
        return res.data;
      }
      // Log detailed error from CDN if response is not as expected but status is OK
      console.error(`CDN upload failed (unexpected response data): ${JSON.stringify(res.data)}`);
    } catch (error: any) {
      console.error(`Error uploading to Facepunch CDN (attempt ${i + 1}):`, error.message);
      if (error.response) {
        console.error(`Status: ${error.response.status}`);
        console.error(`Headers:`, error.response.headers);
        console.error(`Data:`, error.response.data);
      } else if (error.request) {
        console.error(`No response received for request:`, error.request);
      } else {
        console.error(`Error details:`, error.config);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000 + i * 5000)); // Delay before retry
  }
  throw new Error("CDN upload failed after multiple retries");
}

// ─────────────────────── Discord webhook ────────────────────
async function postDiscord(serverData: any, cdnUrl: string, errorMessage?: string, tags?: string[]) {
  const infoLines = [
    `**Name:** ${serverData.name || 'N/A'}`,
    `**Map:** ${serverData.map || 'N/A'}`,
    `**Connection:** ${serverData.connect || 'N/A'}`,
    `**Ping:** ${serverData.ping ?? 'N/A'}ms`,
    `**Players:** ${serverData.raw.numplayers ?? 'N/A'}/${serverData.maxplayers ?? 'N/A'}`
  ];

  const ruleLines = Object.entries(serverData.raw.rules).map(([k,v])=>`\`${k}\`: ${v}`);

  let description = [...infoLines, "", "**Rules:**", ...ruleLines].join("\n");
  if (errorMessage) {
    description = `❌ **Error:** ${errorMessage}\n\n${description}`;
  } else if (tags && tags.length > 0) {
    description += `\n\n**Tags:** ${tags.map(tag => `\`${tag}\``).join(', ')}`;
  }

  await axios.post(HOOK!, {
    content: errorMessage
      ? `🗺 **${serverData.connect}**\nFailed to upload map to Facepunch CDN. Only original link available: ${cdnUrl}`
      : `🗺 **${serverData.connect}**\n${cdnUrl}`,
    embeds:[{ title:"Server Information", description }]
  }, { timeout:15000 });
}

// ─────────────────────────── main ────────────────────────────
async function main() {
  try {
    await init(); // Ensure directories exist
    const cache = await loadCache();
    let allServers: string[] = [];
    
    try {
      allServers = await fetchServers();
      console.log(`Fetched ${allServers.length} servers from Steam API`);
    } catch (error) {
      console.error('Error fetching servers from Steam API:', error);
      // Если не удалось получить серверы, используем пустой массив
      console.log('Continuing with empty server list');
    }

    let cursor = 0;
    // CHUNK and CONCURRENCY are already defined at module scope using env vars.
    const limit = pLimit(CONCURRENCY);
    
    // Создаем один экземпляр браузера для всех скачиваний
    let browser: puppeteer.Browser | undefined;
    try {
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080',
            '--js-flags="--max-old-space-size=512"',
          ]
        });
        console.log('Successfully launched browser instance');
      } catch (browserError) {
        console.error('Failed to launch browser:', browserError);
        // Продолжаем без общего браузера, downloadMap создаст отдельные экземпляры
        console.log('Will create individual browser instances for each download');
      }
      
      while (cursor < allServers.length) {
        try {
          const slice = allServers.slice(cursor, cursor + CHUNK);
          if (slice.length === 0) { 
            if (allServers.length === 0) {
              console.log('No servers to process, exiting loop');
              break;
            }
            cursor = 0; 
            slice.push(...allServers.slice(0, CHUNK)); 
          }

          console.log(`Processing slice ${cursor}-${cursor + slice.length - 1}`);

          // Используем Promise.allSettled, чтобы обработка продолжалась даже при ошибках отдельных карт
          await Promise.allSettled(slice.map(addr => limit(async () => {
            try {
              const [ip, p] = addr.split(":" as const);
              const port = Number(p);
              let serverData: any;
              try { 
                serverData = await getRules(ip, port); 
              } catch (error) {
                console.error(`Failed to get rules for ${addr}:`, error);
                return;
              }

              let url;
              try {
                url = pickLevelUrl(serverData?.raw?.rules || {});
                if (!url) {
                  console.log(`No levelurl found for ${addr}`);
                  return;
                }
              } catch (urlError) {
                console.error(`Error extracting levelurl for ${addr}:`, urlError);
                return;
              }

              // CHECK: if map is already downloaded or previously failed - skip
              try {
                if (cache.downloadedFileUrls.includes(url) || cache.failedUrls.some(f => f.url === url)) {
                  console.log(`Skipping: ${url} (already downloaded or failed previously)`);
                  return;
                }
              } catch (cacheError) {
                console.error(`Error checking cache for ${url}:`, cacheError);
                // Продолжаем выполнение даже при ошибке проверки кэша
              }

              // Try to download even if the URL was in failedUrls
              try {
                // Передаем общий браузер в функцию downloadMap
                const result = await downloadMap(url, browser);
                if (!result) {
                  throw new Error('Download returned no result');
                }
                const { buffer, fileName } = result;
                
                let cdnUrl;
                try {
                  cdnUrl = await uploadToFacepunch(buffer, fileName);
                } catch (uploadError: unknown) {
                  console.error(`Failed to upload to Facepunch CDN: ${url}`, uploadError);
                  // Если загрузка не удалась, сообщаем об ошибке, но не прерываем процесс
                  try {
                    await postDiscord(serverData, url, `Upload to CDN failed: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
                  } catch (discordError) {
                    console.error('Failed to post to Discord:', discordError);
                  }
                  
                  // Добавляем в список неудачных
                  cache.failedUrls = cache.failedUrls || [];
                  if (!cache.failedUrls.some(f => f.url === url)) {
                    cache.failedUrls.push({
                      url,
                      error: uploadError instanceof Error ? uploadError.message : String(uploadError),
                      timestamp: new Date().toISOString()
                    });
                  }
                  await saveCache(cache);
                  return;
                }
                
                const tags = generateTags(fileName); // Generate tags

                try {
                  await postDiscord(serverData, cdnUrl, undefined, tags);
                } catch (discordError) {
                  console.error('Failed to post to Discord:', discordError);
                  // Продолжаем выполнение даже при ошибке отправки в Discord
                }

                // Remove URL from failedUrls if it was there
                if (cache.failedUrls) {
                  cache.failedUrls = cache.failedUrls.filter(f => f.url !== url);
                }

                cache.downloadedFileUrls.push(url);
                cache.totalFilesDownloaded += 1;
                console.log("uploaded", cdnUrl);
                
                try {
                  await saveCache(cache); // Save cache after each successful download
                } catch (saveCacheError) {
                  console.error('Failed to save cache:', saveCacheError);
                }
              } catch (error) {
                console.error(`Failed to process ${url}:`, error);
                if (error && typeof error === 'object' && 'response' in error) {
                  const responseError = error as { response?: { body?: unknown } };
                  console.error('Response from got-scraping:', responseError.response?.body);
                }
                
                try {
                  cache.failedUrls = cache.failedUrls || [];
                  // Check if this URL is already in failedUrls
                  if (!cache.failedUrls.some(f => f.url === url)) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    cache.failedUrls.push({
                      url,
                      error: errorMessage || 'Unknown error',
                      timestamp: new Date().toISOString()
                    });
                  }
                  
                  try {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    await postDiscord(serverData, url, errorMessage || 'Failed to download or upload map');
                  } catch (discordError) {
                    console.error('Failed to post to Discord:', discordError);
                  }
                  
                  await saveCache(cache); // Save cache after each error
                } catch (finalError) {
                  console.error('Fatal error in error handling:', finalError);
                  // Даже если не удалось обработать ошибку, продолжаем работу
                }
              }
            } catch (error) {
              console.error(`Unexpected error processing ${addr}:`, error);
              // Продолжаем выполнение даже при неожиданной ошибке
            }
          })));

          cursor += CHUNK;
        } catch (error) {
          console.error(`Error processing slice ${cursor}-${cursor + CHUNK}:`, error);
          cursor += CHUNK; // Continue with next slice even if current one failed
        }
      }
    } finally {
      // Закрываем общий браузер в блоке finally
      if (browser) {
        try {
          await browser.close();
          console.log('Successfully closed shared browser instance');
        } catch (error) {
          console.error('Error closing shared browser:', error);
        }
        if (global.gc) {
          try {
            global.gc();
          } catch (gcError) {
            console.error('Error running garbage collection:', gcError);
          }
        }
      }
    }

    console.log(`Run complete. Total processed: ${cache.totalFilesDownloaded}, Failed: ${cache.failedUrls?.length || 0}`);
  } catch (error) {
    console.error('Fatal error in main process:', error);
    // Не завершаем процесс с ошибкой, просто логируем
    console.log('Process will exit with code 0 despite errors');
    // process.exit(1); - убираем, чтобы процесс всегда завершался успешно
  }
}

main().catch(e => { 
  console.error('Unhandled error:', e); 
  // Не завершаем процесс с ошибкой, просто логируем
  console.log('Process will exit with code 0 despite unhandled error');
  // process.exit(1); - убираем, чтобы процесс всегда завершался успешно
}); 