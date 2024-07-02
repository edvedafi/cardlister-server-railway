export interface Aggregations {
  aggregations: Filters;
}

export interface FilterParams {
  filters: Filters;
}

export interface Filters {
  sport: Filter[];
  year: Filter[];
  setName: Filter[];
  variant: Filter[];
  variantName: any[];
}

export interface Filter {
  label: string;
  count: number;
  slug: string;
  active: boolean;
}

export interface Card {
  cardNo: string;
  year: string;
  setName: string;
  variantName: string;
  players: string[];
  teamName: string; //TODO: remove this or the next line
  teams: string;
  id: string;
  sportlots?: string;
  features?: string;
  printRun?: string;
  autograph?: string;
  insert?: string;
  parallel?: string;
  bin?: string;
  size?: string;
  thickness?: string;
  bsc?: string;
  cardName?: string;
  grade?: number;
  graded?: boolean | string;
  grader?: string;
}
