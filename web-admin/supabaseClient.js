import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';

const supabaseUrl = 'https://irdccxgbgkzxdjfskbdx.supabase.co';
const supabaseAnonKey =
  'sb_publishable_13kjiGwaJdMfnOdTMOviAw_QXcIl3q4';

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase URL ou anon key manquants');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const supabaseAuthAdmin = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storageKey: 'sb-irdccxgbgkzxdjfskbdx-auth-token-admin',
  },
});
