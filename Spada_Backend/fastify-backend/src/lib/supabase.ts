import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Public / Anon client
export const supabasePublic = createClient(supabaseUrl, supabaseAnonKey);

// Admin / Service Role client (bypasses RLS for backend operations)
export const supabaseAdmin = createClient(
  supabaseUrl, 
  supabaseServiceKey || supabaseAnonKey
);

// Backward-compatibility default export
export default supabasePublic;