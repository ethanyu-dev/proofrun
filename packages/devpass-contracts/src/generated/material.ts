/** 从 JSON Schema 自动生成；请修改契约源文件后重新生成。 */

export type Material =
  | {
      type: 'http_bearer';
      access_token: string;
    }
  | {
      type: 'browser_cookies';
      /**
       * @minItems 1
       * @maxItems 64
       */
      cookies: [
        {
          name: string;
          value: string;
          domain: string;
          host_only: true;
          path: string;
          secure: boolean;
          http_only: boolean;
          same_site: 'Strict' | 'Lax' | 'None';
          expires_at: string | null;
        },
        ...{
          name: string;
          value: string;
          domain: string;
          host_only: true;
          path: string;
          secure: boolean;
          http_only: boolean;
          same_site: 'Strict' | 'Lax' | 'None';
          expires_at: string | null;
        }[],
      ];
    }
  | {
      type: 'browser_storage';
      /**
       * @minItems 1
       * @maxItems 64
       */
      entries: [
        {
          storage: 'localStorage' | 'sessionStorage';
          key: string;
          value: string;
        },
        ...{
          storage: 'localStorage' | 'sessionStorage';
          key: string;
          value: string;
        }[],
      ];
    };
