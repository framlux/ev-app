-- Up Migration

-- Spec §4.2. The one Rivian account's session, sealed to the connector.
--
-- `sealed` is a compact JWE (ECDH-ES+A256KW / A256GCM) of `{userSessionToken}`
-- and nothing else, encrypted by the web pod to the connector's PUBLIC key. The
-- web can therefore write this column and can never read it back, and a dump of
-- this database without the connector's private key yields nothing. That is the
-- entire reason the token is allowed to be stored at all (§4.1): a Rivian
-- cannot stream unless a session is held open around the clock, so a standing
-- credential is unavoidable, and the design controls WHO CAN READ IT instead.
-- Nothing in this table is ever a plaintext secret. `accessToken` and
-- `refreshToken` are not stored in any form - nothing uses them, and keeping
-- them would only widen what a leak exposes.
--
-- ONE ACCOUNT, ONE ROW. The primary key is pinned to 1 by the CHECK, so a
-- second sign-in is an UPDATE of the same row and a "which credential is the
-- current one" question cannot arise. The connector subscribes for exactly one
-- car (EV_VEHICLE_VIN), and a table that allowed two credentials would be
-- inviting a design that does not exist. If a second account is ever wanted,
-- that is a migration with a real key, not a row someone inserts by hand.
--
-- `updated_at` is the connector's change signal: it polls this stamp every 15 s
-- and a changed value restarts its loop from `starting` with the new session
-- (§5.2). The column default applies on INSERT only, so the writer sets it
-- EXPLICITLY on the upsert's update branch; without that a re-sign-in would
-- change `sealed`, leave the stamp where it was, and the connector would sit in
-- `unauthenticated` for good waiting for a change it had already been given.
CREATE TABLE rivian_credential (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- one account, one row
  sealed      TEXT        NOT NULL,                            -- compact JWE
  -- The email the owner signed in with, shown on the settings page so they can
  -- tell which account is connected. It is not a secret and it is not used to
  -- authenticate: the sealed token is the credential.
  account     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Spec §5.7. What the connector last reported about itself, so the settings
-- page can answer "is it working" without reaching the connector at all - the
-- web pod and the connector share a database and nothing else.
--
-- WRITTEN ONLY BY THE CONNECTOR, asynchronously and best-effort: a failed write
-- is logged and retried with the next change, and the socket never waits on it
-- (Postgres is not on its critical path, §5.2). That makes every column here a
-- report EXCEPT ONE: `dropped_properties`, which the connector reads back once,
-- at `starting`, to leave those properties out of its subscription groups so a
-- restart does not repeat the bisection (§5.4); if that read fails it starts
-- from `[]` and searches again. For every other column a stale row can mislead
-- a person but cannot misdirect the connector. For that one it can, and the
-- cost is bounded and visible: a property wrongly on the list is simply not
-- subscribed until the daily re-probe (§5.4) accepts it and the connector
-- rewrites the list without it, and a list that is missing a bad property just
-- costs one more bisection.
--
-- ONE ROW, for the same reason as the credential: there is one connector for
-- one car.
--
-- `last_error` holds ONLY the §4.4 redacted form: `{httpStatus, codes}` reduced
-- to a message by the Rivian client, which is built so that no token, password,
-- OTP, header, request body or response body can reach it. This table is read
-- by an internet-facing pod, so the column is a place a secret would leak to
-- rather than from. The writer must not add to it - not a raw upstream message,
-- not "context" - because redaction is done once, at the source, and anything
-- concatenated afterwards escapes it.
--
-- `state` is the §5.2 state machine's name for where the connector is. The
-- CHECK is the list, so a misspelt state is refused at the write instead of
-- being stored and then rendered by the page as nothing, which looks exactly
-- like a healthy idle.
--
-- `dropped_properties` are the vehicleState properties the gateway schema
-- rejected and bisection removed (§5.4), persisted so a restart can honour
-- them (see the exception above). A NOT NULL list rather than a nullable
-- one, because "none dropped" is an answer the page prints and `NULL` would
-- leave it unable to tell that from "never reported".
CREATE TABLE rivian_status (
  id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state              TEXT NOT NULL CHECK (state IN (
                       'signed_out', 'starting', 'credential_invalid',
                       'finding_vehicle', 'waiting_for_vehicle', 'connecting',
                       'subscribed', 'backing_off', 'unauthenticated')),
  vin                TEXT,
  rivian_vehicle_id  TEXT,
  last_frame_at      TIMESTAMPTZ,
  last_error         TEXT,                     -- §4.4 redacted form only
  backoff_until      TIMESTAMPTZ,
  dropped_properties TEXT[] NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE rivian_status;
DROP TABLE rivian_credential;
