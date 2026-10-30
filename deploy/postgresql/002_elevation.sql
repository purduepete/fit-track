-- Explicit reviewed deployment step. Runtime startup never executes DDL.
-- The 10/18 rename moved the ledger row from 'fittrack' (001) to 'fit-track'.
BEGIN;
DO $$
BEGIN
    PERFORM 1 FROM public.solutiondeploy_schema WHERE app_id = 'fit-track' AND version = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Fit Track schema ledger must be version 1 before migration';
    END IF;
END $$;
ALTER TABLE public.workouts ADD COLUMN elevation_gain_m DOUBLE PRECISION NULL;
ALTER TABLE public.workout_splits ADD COLUMN elevation_gain_m DOUBLE PRECISION NULL;
UPDATE public.solutiondeploy_schema SET version = 2 WHERE app_id = 'fit-track' AND version = 1;
COMMIT;
