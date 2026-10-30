-- Explicit reviewed deployment step. Runtime startup never executes DDL.
BEGIN;
DO $$
BEGIN
    PERFORM 1 FROM public.solutiondeploy_schema WHERE app_id = 'fit-track' AND version = 2 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Fit Track schema ledger must be version 2 before migration';
    END IF;
END $$;
ALTER TABLE public.workouts
    ADD COLUMN point_exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD CONSTRAINT ck_workouts_point_exclusions_array CHECK (jsonb_typeof(point_exclusions) = 'array');
UPDATE public.solutiondeploy_schema SET version = 3 WHERE app_id = 'fit-track' AND version = 2;
COMMIT;
