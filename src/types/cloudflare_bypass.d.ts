declare module '../cloudflare_bypass/index.js' {
  interface CloudFreedInstance {
    success: boolean;
    code: number;
    errormessage?: string;
    userAgent: string;
    webSocketDebuggerUrl: string;
    port: number;
    Solve(options: { type: string; url: string; userAgent: string; sitekey?: string; action?: string; proxy?: { scheme: string; host: string; port: number; username?: string; password?: string }; }): Promise<{ cookie: string; } & any>;
    Close(): Promise<void>;
  }

  class CloudFreed {
    constructor();
    start(headless: boolean, logs: boolean): Promise<CloudFreedInstance | { success: false; code: number; errormessage: string }>;
  }
  export default CloudFreed;
} 