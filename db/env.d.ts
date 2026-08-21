declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ALIBABA_CLOUD_ACCESS_KEY_ID?: string;
    ALIBABA_CLOUD_ACCESS_KEY_SECRET?: string;
    ALIBABA_CLOUD_SECURITY_TOKEN?: string;
    PULSEDNS_SELF_HOSTED?: string;
    PULSEDNS_DB_PATH?: string;
    PULSEDNS_PUBLIC_URL?: string;
    PULSEDNS_ADMIN_USER?: string;
    PULSEDNS_ADMIN_PASSWORD?: string;
    PULSEDNS_ADMIN_EMAIL?: string;
  }
}
