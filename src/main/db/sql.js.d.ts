declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export interface Database {
    run(sql: string, params?: BindParams): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    prepare(sql: string, params?: BindParams): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  export interface Statement {
    bind(params: BindParams): void;
    step(): boolean;
    get(): SqlValue[];
    getColumnNames(): string[];
    free(): boolean;
  }

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export type SqlValue = string | number | null | Uint8Array;
  export type BindParams = unknown[] | Record<string, unknown>;

  export interface Config {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: Config): Promise<SqlJsStatic>;
}
