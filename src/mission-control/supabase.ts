import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabaseServiceClient: SupabaseClient | null = null;

export function getSupabaseServiceClient(): SupabaseClient | null {
  if (supabaseServiceClient) return supabaseServiceClient;

  const url =
    process.env.MYO_SUPABASE_URL || process.env.SUPABASE_URL || process.env.MOLT_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.MYO_SUPABASE_SERVICE_KEY || "";

  if (!url || !serviceKey) return null;

  supabaseServiceClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return supabaseServiceClient;
}
