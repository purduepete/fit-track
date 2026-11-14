-- Explicit reviewed deployment step. Runtime startup never executes DDL.
-- Run as the migration identity with SET ROLE sd_fittrack_owner.
BEGIN;
DO $$
BEGIN
    PERFORM 1 FROM public.solutiondeploy_schema WHERE app_id = 'fit-track' AND version = 3 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Fit Track schema ledger must be version 3 before migration';
    END IF;
END $$;
ALTER TABLE public.workouts
    ADD COLUMN average_watts DOUBLE PRECISION NULL,
    ADD COLUMN average_cadence DOUBLE PRECISION NULL,
    ADD COLUMN watts_per_kg DOUBLE PRECISION NULL;
CREATE TABLE public.athlete_profile (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    weight_kg DOUBLE PRECISION NOT NULL CHECK (weight_kg > 0 AND weight_kg < 400),
    updated_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL
);
INSERT INTO public.athlete_profile (id, weight_kg, updated_utc) VALUES (1, 84.2, timezone('utc', now()));
GRANT SELECT, INSERT, UPDATE ON public.athlete_profile TO sd_fittrack_runtime;
UPDATE public.solutiondeploy_schema SET version = 4 WHERE app_id = 'fit-track' AND version = 3;
COMMIT;
