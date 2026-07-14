import type { SupabaseClient } from "npm:@supabase/supabase-js@2";


const USERNAME = Deno.env.get("PADEL_USERNAME") ?? "";
const PASSWORD = Deno.env.get("PADEL_PASSWORD") ?? "";
const CLIENT_SECRET = Deno.env.get("PADEL_CLIENT_SECRET") ?? "";
const CLIENT_ID = Deno.env.get("PADEL_CLIENT_ID") ?? "";
const AUTH_URL = Deno.env.get("PADEL_AUTH_URL") ?? "";
const HEADERS_URL = Deno.env.get("PADEL_HEADERS_URL") ?? "";
const GRANT_TYPE = "password";

export async function getValidToken(supabaseAdmin: SupabaseClient) {
  const { data: state } = await supabaseAdmin.from("api_state").select("*").eq(
    "id",
    "current",
  ).single();

  const now = new Date();
  if (
    state?.access_token && state.token_expires_at &&
    new Date(state.token_expires_at).getTime() - now.getTime() > 120000
  ) {
    return state.access_token;
  }

  const formBody = new URLSearchParams();
  formBody.append("username", USERNAME);
  formBody.append("password", PASSWORD);
  formBody.append("client_id", CLIENT_ID);
  formBody.append("client_secret", CLIENT_SECRET);
  formBody.append("grant_type", GRANT_TYPE);

  const response = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Dart/3.7 (dart:io)",
    },
    body: formBody.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Auth failed: ${response.status} - ${errText}`);
  }

  const authData = await response.json();
  const expiresAt = new Date(Date.now() + authData.expires_in * 1000)
    .toISOString();

  await supabaseAdmin.from("api_state").upsert({
    id: "current",
    access_token: authData.access_token,
    token_expires_at: expiresAt,
    refresh_token: authData.refresh_token,
  });

  return authData.access_token;
}

export async function getDynamicHeaders(supabaseAdmin: any) {
  const { data: state } = await supabaseAdmin.from("api_state").select(
    "dynamic_headers, headers_updated_at",
  ).eq("id", "current").single();

  const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
  if (
    state?.dynamic_headers && state.headers_updated_at &&
    new Date(state.headers_updated_at).getTime() > threeDaysAgo
  ) {
    return state.dynamic_headers;
  }

  console.log("Syncing dynamic head variables...");
  const response = await fetch(HEADERS_URL);
  if (!response.ok) {
    throw new Error("Failed syncing metadata configuration headers.");
  }

  const freshHeaders = await response.json();
  const mappedHeaders = {
    "x-app-build": freshHeaders?.buildNumber ?? 2107,
    "x-app-version": freshHeaders?.versionName ?? "1.33.0",
  };

  await supabaseAdmin.from("api_state").update({
    dynamic_headers: mappedHeaders,
    headers_updated_at: new Date().toISOString(),
  }).eq("id", "current");

  return mappedHeaders;
}
