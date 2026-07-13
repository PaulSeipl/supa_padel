-- Grant permissions for the state table
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_state TO service_role;

-- Grant permissions for the tracking table (just to be safe!)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notified_slots TO service_role;