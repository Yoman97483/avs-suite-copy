import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://irdccxgbgkzxdjfskbdx.supabase.co';
const SUPABASE_ANON_KEY =
  'sb_publishable_13kjiGwaJdMfnOdTMOviAw_QXcIl3q4';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storageKey: 'sb-irdccxgbgkzxdjfskbdx-auth-token-mobile',
  },
});
