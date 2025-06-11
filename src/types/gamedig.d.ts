declare module 'gamedig' {
  interface QueryOptions {
    type: string;
    host: string;
    port: number;
    requestRules?: boolean;
    skipInfo?: boolean;
    skipPlayers?: boolean;
    givenPortOnly?: boolean;
    udpTimeout?: number;
    socketTimeout?: number;
    maxAttempts?: number;
  }

  interface QueryResult {
    raw: {
      rules: Record<string, string>;
    };
  }

  function query(options: QueryOptions): Promise<QueryResult>;
  
  export = {
    query
  };
} 