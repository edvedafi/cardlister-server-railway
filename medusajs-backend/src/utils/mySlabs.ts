import axios, { AxiosInstance } from 'axios';

export const categories = [
  'BASEBALL',
  'BASKETBALL',
  'FOOTBALL',
  'OTHER',
  'OTHER_NONSPORT',
  'HOCKEY',
  'SOCCER',
  'POKEMON',
  'FORMULA_ONE',
  'TICKETS_MEMORABILIA',
];

export const graders = ['PSA', 'BECKETT', 'SGC', 'CGC', 'BVG', 'CSG', 'REDEMPTION'];

export type Slab = {
  id: number;
  title: string;
  price: string;
  shipping_cost?: string | null;
  description?: string | null;
  publish_type:
    | 'SLABBED_CARD'
    | 'SLABBED_COMIC'
    | 'RAW_CARD_SINGLE'
    | 'RAW_CARD_LOT'
    | 'WAX'
    | 'RAW_COMIC_SINGLE'
    | 'RAW_COMIC_LOT';
  category:
    | 'BASEBALL'
    | 'BASKETBALL'
    | 'FOOTBALL'
    | 'OTHER'
    | 'OTHER_NONSPORT'
    | 'HOCKEY'
    | 'SOCCER'
    | 'POKEMON'
    | 'FORMULA_ONE'
    | 'TICKETS_MEMORABILIA';
  card_type?: 'PSA' | 'BECKETT' | 'SGC' | 'CGC' | 'BVG' | 'CSG' | 'REDEMPTION' | null;
  lot_type?: 'INSERT_LOT' | 'PLAYER_LOT' | 'COMPLETE_SET' | 'PARTIAL_SET' | 'TEAM_SET' | 'OTHER' | null;
  grade?: number | null;
  condition?:
    | 'MYSLABS_A'
    | 'MYSLABS_B'
    | 'MYSLABS_C'
    | 'MYSLABS_D'
    | 'MYSLABS_E'
    | 'NEAR_MINT'
    | 'VERY_FINE'
    | 'FINE'
    | 'VERY_GOOD'
    | 'GOOD'
    | 'FAIR'
    | null;
  year: number;
  for_sale: boolean;
  allow_offer: boolean;
  minimum_offer?: number;
  slab_image_1: string;
  slab_image_2: string;
  external_id?: string | null;
};

export async function login(
  axiosLogin: (url: string, headers: Record<string, string>) => AxiosInstance,
): Promise<AxiosInstance> {
  const response = await axios.post(
    'https://myslabs.com/api/v2/oauth2/token',
    'grant_type=client_credentials',
    // {
    //   grant_type: 'client_credentials',
    // },
    {
      headers: {
        Authorization: `Basic ${process.env.MYSLABS_BASE64}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );
  const { access_token } = response.data;
  return axiosLogin('https://myslabs.com/api/v2', {
    Authorization: `Bearer ${access_token}`,
  });
}
