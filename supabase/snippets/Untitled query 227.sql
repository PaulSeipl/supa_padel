CREATE TABLE notified_slots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  court_id text NOT NULL,
  slot_time text NOT NULL,
  duration_seconds integer NOT NULL,
  court_type text,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE api_state (
  id text PRIMARY KEY DEFAULT 'current',
  access_token text,
  token_expires_at timestamp with time zone,
  refresh_token text,
  dynamic_headers jsonb,
  headers_updated_at timestamp with time zone,
  CONSTRAINT single_row CHECK (id = 'current') -- Guarantees only 1 row exists
);

INSERT INTO api_state (id) VALUES ('current') ON CONFLICT DO NOTHING;