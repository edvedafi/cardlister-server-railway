export type SyncRequest = {
  sku?: string | string[];
  bin?: string | string[];
  category?: string | string[];
  only?: string[];
  user: string;
};
