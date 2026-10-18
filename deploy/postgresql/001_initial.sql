CREATE SCHEMA fit;
CREATE TABLE public.solutiondeploy_schema (app_id text PRIMARY KEY, version integer NOT NULL);
INSERT INTO public.solutiondeploy_schema VALUES ('fittrack', 1);

CREATE TABLE fit.api_tokens (
	id SERIAL NOT NULL,
	name VARCHAR(100) NOT NULL,
	token_hash VARCHAR(64) NOT NULL,
	scope VARCHAR(20) NOT NULL,
	disabled BOOLEAN NOT NULL,
	created_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	last_used_utc TIMESTAMP WITHOUT TIME ZONE,
	PRIMARY KEY (id),
	UNIQUE (token_hash)
)

;

CREATE TABLE fit.daily_metrics (
	id BIGSERIAL NOT NULL,
	local_date VARCHAR(10) NOT NULL,
	metric_type VARCHAR(40) NOT NULL,
	value FLOAT NOT NULL,
	unit VARCHAR(20),
	source_name VARCHAR(120),
	updated_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_fit_daily UNIQUE (local_date, metric_type, source_name)
)

;

CREATE TABLE fit.raw_ingest_events (
	id BIGSERIAL NOT NULL,
	source VARCHAR(50) NOT NULL,
	received_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	payload_hash VARCHAR(64) NOT NULL,
	payload_json TEXT NOT NULL,
	status VARCHAR(20) NOT NULL,
	error TEXT,
	processed_utc TIMESTAMP WITHOUT TIME ZONE,
	PRIMARY KEY (id),
	UNIQUE (payload_hash)
)

;

CREATE TABLE fit.workouts (
	uuid VARCHAR(80) NOT NULL,
	workout_type VARCHAR(60) NOT NULL,
	source_name VARCHAR(120),
	device_name VARCHAR(120),
	start_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	end_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	tz_offset_minutes INTEGER,
	local_date VARCHAR(10) NOT NULL,
	duration_sec FLOAT,
	distance_m FLOAT,
	active_energy_kcal FLOAT,
	avg_hr FLOAT,
	max_hr FLOAT,
	min_hr FLOAT,
	has_route BOOLEAN NOT NULL,
	created_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	updated_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (uuid)
)

;

CREATE TABLE fit.workout_route_points (
	id BIGSERIAL NOT NULL,
	workout_uuid VARCHAR(80) NOT NULL,
	seq INTEGER NOT NULL,
	ts_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	lat FLOAT NOT NULL,
	lon FLOAT NOT NULL,
	elevation_m FLOAT,
	speed_mps FLOAT,
	PRIMARY KEY (id),
	FOREIGN KEY(workout_uuid) REFERENCES fit.workouts (uuid) ON DELETE CASCADE
)

;

CREATE TABLE fit.workout_samples (
	id BIGSERIAL NOT NULL,
	workout_uuid VARCHAR(80) NOT NULL,
	metric_type VARCHAR(40) NOT NULL,
	start_utc TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	end_utc TIMESTAMP WITHOUT TIME ZONE,
	value FLOAT NOT NULL,
	unit VARCHAR(20),
	PRIMARY KEY (id),
	FOREIGN KEY(workout_uuid) REFERENCES fit.workouts (uuid) ON DELETE CASCADE
)

;

CREATE TABLE fit.workout_splits (
	id BIGSERIAL NOT NULL,
	workout_uuid VARCHAR(80) NOT NULL,
	unit_system VARCHAR(4) NOT NULL,
	split_index INTEGER NOT NULL,
	distance_m FLOAT NOT NULL,
	duration_sec FLOAT NOT NULL,
	pace_sec_per_unit FLOAT NOT NULL,
	avg_hr FLOAT,
	source VARCHAR(10) NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_fit_split UNIQUE (workout_uuid, unit_system, split_index),
	FOREIGN KEY(workout_uuid) REFERENCES fit.workouts (uuid) ON DELETE CASCADE
)

;
CREATE INDEX ix_fit_daily_type_date ON fit.daily_metrics (metric_type, local_date);
CREATE INDEX ix_fit_workouts_start ON fit.workouts (start_utc);
CREATE INDEX ix_fit_workouts_type_date ON fit.workouts (workout_type, local_date);
CREATE INDEX ix_fit_route_workout_seq ON fit.workout_route_points (workout_uuid, seq);
CREATE INDEX ix_fit_sample_workout_metric ON fit.workout_samples (workout_uuid, metric_type, start_utc);
