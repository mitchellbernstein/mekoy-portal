BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('video-workspace-schema',0));
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL DEFAULT false,
  image text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "workspacePlan" text NOT NULL DEFAULT 'workspace' CHECK("workspacePlan" IN ('free','workspace'));
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session("userId");
CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz, scope text, password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_user_idx ON account("userId");
CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS teams (id text PRIMARY KEY, name text NOT NULL, owner_id text NOT NULL REFERENCES "user"(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memberships (team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, role text NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(team_id,user_id));
CREATE TABLE IF NOT EXISTS folders (id text PRIMARY KEY, name text NOT NULL, owner_id text NOT NULL REFERENCES "user"(id), team_id text REFERENCES teams(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meeting_notes (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), client_meeting_id text NOT NULL,
  team_id text REFERENCES teams(id), folder_id text REFERENCES folders(id) ON DELETE SET NULL, title text NOT NULL, notes_text text NOT NULL,
  summary text, transcript jsonb NOT NULL CHECK(jsonb_typeof(transcript)='array'),
  source_revision bigint NOT NULL CHECK(source_revision>=0), source_created_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0), source_hash text NOT NULL, search_text text NOT NULL,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,search_text)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(owner_id,client_meeting_id)
);
ALTER TABLE meeting_notes ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS folder_id text REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS meeting_notes_team_updated_idx ON meeting_notes(team_id,updated_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_notes_folder_updated_idx ON meeting_notes(folder_id,updated_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_notes_owner_client_idx ON meeting_notes(owner_id,client_meeting_id);
CREATE INDEX IF NOT EXISTS meeting_notes_search_idx ON meeting_notes USING gin(search_document);
CREATE TABLE IF NOT EXISTS videos (
  id text PRIMARY KEY, recording_id text NOT NULL, owner_id text NOT NULL REFERENCES "user"(id), title text NOT NULL,
  team_id text REFERENCES teams(id), folder_id text REFERENCES folders(id), mime_type text NOT NULL,
  duration_ms integer NOT NULL CHECK(duration_ms>=0), byte_length bigint NOT NULL CHECK(byte_length>0),
  upload_state text NOT NULL DEFAULT 'pending' CHECK(upload_state IN ('pending','uploaded')),
  upload_sha256 text, storage_key text NOT NULL, storage_etag text, receipt_id text, received_bytes bigint,
  processing_status text NOT NULL DEFAULT 'pending', ai_status text NOT NULL DEFAULT 'not_configured', processing_error text,
  stream_uid text UNIQUE, slack_generation integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,recording_id)
);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS slack_generation integer NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS chapters jsonb CHECK(chapters IS NULL OR jsonb_typeof(chapters)='array');
ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcript_hash text;
CREATE INDEX IF NOT EXISTS video_team_idx ON videos(team_id);
CREATE TABLE IF NOT EXISTS video_share_links (
  id text PRIMARY KEY, video_id text NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, token_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT (now()+interval '168 hours'), revoked_at timestamptz
);
ALTER TABLE video_share_links
  ADD COLUMN IF NOT EXISTS stream_token_ciphertext text,
  ADD COLUMN IF NOT EXISTS stream_token_expires_at timestamptz CHECK(stream_token_expires_at<=expires_at),
  ADD COLUMN IF NOT EXISTS stream_token_refresh_at timestamptz,
  ADD COLUMN IF NOT EXISTS stream_token_uid text;
CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY, video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE, parent_id text REFERENCES comments(id),
  author_id text REFERENCES "user"(id), author_name text NOT NULL, body text NOT NULL,
  position_ms integer CHECK(position_ms>=0), source text NOT NULL DEFAULT 'web',
  slack_user_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS comments_video_idx ON comments(video_id,created_at);
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY, video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE, actor_id text REFERENCES "user"(id), actor_name text NOT NULL,
  kind text NOT NULL, body text, comment_id text REFERENCES comments(id), position_ms integer, operation_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS comment_id text REFERENCES comments(id);
UPDATE events e SET comment_id=c.id FROM comments c WHERE e.comment_id IS NULL AND e.operation_key='comment:'||c.id;
CREATE TABLE IF NOT EXISTS notifications (event_id text REFERENCES events(id) ON DELETE CASCADE, user_id text REFERENCES "user"(id) ON DELETE CASCADE, PRIMARY KEY(event_id,user_id));
CREATE TABLE IF NOT EXISTS views (video_id text REFERENCES videos(id), viewer_id text REFERENCES "user"(id), day date NOT NULL DEFAULT current_date, event_id text NOT NULL, PRIMARY KEY(video_id,viewer_id,day), UNIQUE(viewer_id,event_id));
ALTER TABLE views ADD COLUMN IF NOT EXISTS viewed_at timestamptz;
ALTER TABLE views ALTER COLUMN viewed_at SET DEFAULT now();
CREATE TABLE IF NOT EXISTS transcript_words (video_id text REFERENCES videos(id) ON DELETE CASCADE, ordinal integer NOT NULL, word text NOT NULL, start_ms integer NOT NULL CHECK(start_ms>=0), end_ms integer NOT NULL CHECK(end_ms>=start_ms), PRIMARY KEY(video_id,ordinal));
CREATE TABLE IF NOT EXISTS search_records (
  id text PRIMARY KEY, video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE, source text NOT NULL CHECK(source IN ('title','comment','speech','visual')),
  text text NOT NULL, position_ms integer, embedding vector(768), document tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX IF NOT EXISTS search_document_idx ON search_records USING gin(document);
ALTER TABLE search_records DROP CONSTRAINT IF EXISTS search_records_source_check;
ALTER TABLE search_records ADD CONSTRAINT search_records_source_check CHECK(source IN ('title','comment','speech','visual'));
CREATE TABLE IF NOT EXISTS search_answer_usage (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  usage_day date NOT NULL, answer_calls integer NOT NULL CHECK(answer_calls>0), PRIMARY KEY(user_id,usage_day)
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY, kind text NOT NULL, video_id text REFERENCES videos(id), operation_key text NOT NULL UNIQUE, payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, external_id text, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status,available_at);
CREATE TABLE IF NOT EXISTS slack_installations (
  id text PRIMARY KEY, team_id text NOT NULL UNIQUE REFERENCES teams(id), slack_team_id text NOT NULL, installed_by text NOT NULL REFERENCES "user"(id),
  bot_user_id text NOT NULL, access_token text NOT NULL, scopes text NOT NULL, status text NOT NULL DEFAULT 'connected', error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS slack_identities (
  installation_id text NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE, slack_user_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id), PRIMARY KEY(installation_id,slack_user_id), UNIQUE(installation_id,user_id)
);
CREATE TABLE IF NOT EXISTS slack_threads (
  id text PRIMARY KEY, video_id text NOT NULL UNIQUE REFERENCES videos(id), installation_id text NOT NULL REFERENCES slack_installations(id),
  channel_id text NOT NULL, root_ts text NOT NULL, thread_url text, error text,
  UNIQUE(installation_id,channel_id,root_ts)
);
CREATE TABLE IF NOT EXISTS slack_messages (
  installation_id text NOT NULL REFERENCES slack_installations(id), channel_id text NOT NULL, message_ts text NOT NULL,
  comment_id text REFERENCES comments(id), video_id text NOT NULL REFERENCES videos(id), exported boolean NOT NULL DEFAULT false,
  PRIMARY KEY(installation_id,channel_id,message_ts), UNIQUE(comment_id)
);
CREATE TABLE IF NOT EXISTS slack_inbox (event_id text PRIMARY KEY, installation_id text REFERENCES slack_installations(id), payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS slack_message_versions (
  installation_id text REFERENCES slack_installations(id), channel_id text NOT NULL, message_ts text NOT NULL,
  revision_ts text NOT NULL, deleted boolean NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(installation_id,channel_id,message_ts)
);
CREATE TABLE IF NOT EXISTS slack_reaction_versions (
  installation_id text REFERENCES slack_installations(id), channel_id text NOT NULL, message_ts text NOT NULL,
  slack_user_id text NOT NULL, emoji text NOT NULL, revision_ts text NOT NULL, active boolean NOT NULL,
  PRIMARY KEY(installation_id,channel_id,message_ts,slack_user_id,emoji)
);
CREATE TABLE IF NOT EXISTS oauth_states (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id), team_id text NOT NULL REFERENCES teams(id), expires_at timestamptz NOT NULL, purpose text NOT NULL DEFAULT 'install');
CREATE TABLE IF NOT EXISTS repository_connections (
  id text PRIMARY KEY, team_id text NOT NULL REFERENCES teams(id), owner_id text NOT NULL REFERENCES "user"(id),
  repository_id bigint NOT NULL, full_name text NOT NULL, github_user_id bigint NOT NULL,
  access_token text NOT NULL, webhook_secret text NOT NULL, webhook_id bigint, branch text NOT NULL,
  status text NOT NULL DEFAULT 'connecting', error text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(team_id,repository_id)
);
CREATE TABLE IF NOT EXISTS github_deliveries (
  connection_id text NOT NULL REFERENCES repository_connections(id), delivery_id text NOT NULL,
  payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,delivery_id)
);
CREATE TABLE IF NOT EXISTS agent_schedules (
  id text PRIMARY KEY, team_id text NOT NULL REFERENCES teams(id), owner_id text NOT NULL REFERENCES "user"(id),
  audience text NOT NULL CHECK(audience IN ('internal','customer')), weekday integer NOT NULL CHECK(weekday BETWEEN 0 AND 6),
  minute integer NOT NULL CHECK(minute BETWEEN 0 AND 1439), time_zone text NOT NULL, next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true, UNIQUE(team_id,audience)
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY, team_id text NOT NULL REFERENCES teams(id), owner_id text NOT NULL REFERENCES "user"(id),
  connection_id text REFERENCES repository_connections(id), audience text NOT NULL CHECK(audience IN ('internal','customer')),
  kind text NOT NULL CHECK(kind IN ('push','release','weekly','manual')), title text NOT NULL, trigger_key text NOT NULL UNIQUE,
  recording_id text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','preparing','ready','running','uploaded','empty','failed')),
  input jsonb NOT NULL DEFAULT '{}', evidence jsonb, claim_hash text, lease_until timestamptz,
  video_id text REFERENCES videos(id), result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_due_idx ON agent_runs(status,created_at);
CREATE TABLE IF NOT EXISTS voice_profiles (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), request_id text NOT NULL,
  name text NOT NULL, provider_voice_id text,
  status text NOT NULL CHECK(status IN ('creating','ready','verification_required','uncertain','failed','deleting','delete_failed','deleted')),
  consent_version text NOT NULL, consented_at timestamptz NOT NULL, sample_sha256 text NOT NULL,
  revoked_at timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_profiles_current_owner_idx ON voice_profiles(owner_id) WHERE status<>'deleted';
CREATE INDEX IF NOT EXISTS voice_profiles_owner_created_idx ON voice_profiles(owner_id,created_at DESC);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS agent_run_id text REFERENCES agent_runs(id);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcription_complete boolean NOT NULL DEFAULT false;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS agent_key text UNIQUE;

ALTER TABLE comments ADD COLUMN IF NOT EXISTS summary_managed boolean NOT NULL DEFAULT false;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS summary_moments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE slack_reaction_versions ADD COLUMN IF NOT EXISTS comment_id text REFERENCES comments(id);
UPDATE comments SET position_ms=0 WHERE position_ms IS NULL;
ALTER TABLE comments ALTER COLUMN position_ms SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS comments_opening_summary_idx ON comments(video_id) WHERE source='summary' AND parent_id IS NULL;
DO $$
BEGIN
  IF to_regclass('public.reactions') IS NOT NULL THEN
    CREATE TEMP TABLE canonical_reaction_ids ON COMMIT DROP AS SELECT r.id AS old_id,CASE WHEN EXISTS(SELECT 1 FROM comments c WHERE c.id=r.id) THEN 'legacy-reaction:'||r.id ELSE r.id END AS comment_id FROM reactions r;
    INSERT INTO comments(id,video_id,parent_id,author_id,author_name,body,position_ms,source,slack_user_id,created_at,updated_at)
      SELECT mapping.comment_id,
        r.video_id,r.comment_id,r.actor_id,r.actor_name,r.emoji,COALESCE(r.position_ms,0),r.source,r.slack_user_id,r.created_at,r.created_at
      FROM reactions r JOIN canonical_reaction_ids mapping ON mapping.old_id=r.id;
    UPDATE events e SET comment_id=c.id,kind=CASE WHEN c.parent_id IS NULL THEN 'comment' ELSE 'reply' END,position_ms=c.position_ms
      FROM reactions r JOIN canonical_reaction_ids mapping ON mapping.old_id=r.id JOIN comments c ON c.id=mapping.comment_id
      WHERE e.operation_key='reaction:'||r.id OR (e.kind='reaction' AND e.video_id=r.video_id AND e.actor_id IS NOT DISTINCT FROM r.actor_id AND e.body=r.emoji AND e.position_ms IS NOT DISTINCT FROM r.position_ms);
    UPDATE slack_reaction_versions version SET comment_id=c.id
      FROM reactions r JOIN canonical_reaction_ids mapping ON mapping.old_id=r.id JOIN comments c ON c.id=mapping.comment_id
        JOIN slack_threads t ON t.video_id=r.video_id
        LEFT JOIN slack_messages message ON message.comment_id=r.comment_id AND message.installation_id=t.installation_id
      WHERE r.source='slack' AND version.installation_id=t.installation_id AND version.channel_id=t.channel_id
        AND version.message_ts=COALESCE(message.message_ts,t.root_ts) AND version.slack_user_id=r.slack_user_id AND r.emoji=':'||version.emoji||':';
    DROP TABLE reactions;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='videos' AND column_name='summary') THEN
    IF EXISTS(SELECT 1 FROM videos WHERE summary IS NOT NULL AND jsonb_typeof(summary)<>'null' AND (jsonb_typeof(summary)<>'object' OR jsonb_typeof(summary->'text') IS DISTINCT FROM 'string')) THEN
      RAISE EXCEPTION 'Cannot migrate an invalid legacy summary without losing its content';
    END IF;
    INSERT INTO comments(id,video_id,author_id,author_name,body,position_ms,source,summary_managed,summary_moments,created_at,updated_at)
      SELECT 'summary:'||v.id,v.id,v.owner_id,u.name,v.summary->>'text',0,'summary',true,COALESCE(v.summary->'moments','[]'::jsonb),v.created_at,v.created_at
      FROM videos v JOIN "user" u ON u.id=v.owner_id
      WHERE v.summary IS NOT NULL AND jsonb_typeof(v.summary)='object'
        AND NOT EXISTS(SELECT 1 FROM comments c WHERE c.video_id=v.id AND c.source='summary' AND c.parent_id IS NULL);
    ALTER TABLE videos DROP COLUMN summary;
  END IF;
END $$;
INSERT INTO comments(id,video_id,author_id,author_name,body,position_ms,source,created_at,updated_at,deleted_at)
  SELECT 'legacy-reaction-event:'||id,video_id,actor_id,actor_name,COALESCE(body,''),COALESCE(position_ms,0),
    CASE WHEN operation_key LIKE 'slack:%' THEN 'slack' ELSE 'web' END,created_at,created_at,created_at
  FROM events WHERE kind='reaction' AND comment_id IS NULL ON CONFLICT(id) DO NOTHING;
UPDATE events e SET comment_id='legacy-reaction-event:'||e.id,kind='comment',position_ms=COALESCE(e.position_ms,0) WHERE e.kind='reaction' AND e.comment_id IS NULL;
INSERT INTO events(id,video_id,actor_id,actor_name,kind,body,comment_id,position_ms,operation_key,created_at)
  SELECT 'comment:'||c.id,c.video_id,c.author_id,c.author_name,CASE WHEN c.parent_id IS NULL THEN 'comment' ELSE 'reply' END,c.body,c.id,c.position_ms,'comment:'||c.id,c.created_at
  FROM comments c WHERE c.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM events e WHERE e.comment_id=c.id) ON CONFLICT(operation_key) DO NOTHING;
UPDATE events e SET position_ms=c.position_ms,kind=CASE WHEN e.kind='reaction' THEN CASE WHEN c.parent_id IS NULL THEN 'comment' ELSE 'reply' END ELSE e.kind END FROM comments c WHERE e.comment_id=c.id;
INSERT INTO notifications(event_id,user_id)
  SELECT e.id,v.owner_id FROM events e JOIN videos v ON v.id=e.video_id WHERE e.comment_id IS NOT NULL AND v.owner_id IS DISTINCT FROM e.actor_id
  UNION SELECT e.id,m.user_id FROM events e JOIN videos v ON v.id=e.video_id JOIN memberships m ON m.team_id=v.team_id WHERE e.comment_id IS NOT NULL AND m.user_id IS DISTINCT FROM e.actor_id
  ON CONFLICT DO NOTHING;
INSERT INTO jobs(id,kind,video_id,operation_key,payload)
  SELECT 'slack:comment:'||c.id,'slack_comment',c.video_id,'slack:comment:'||c.id,jsonb_build_object('commentId',c.id,'action','create','actorId',COALESCE(c.author_id,v.owner_id))
  FROM comments c JOIN videos v ON v.id=c.video_id WHERE c.source IN ('web','agent','summary') AND c.deleted_at IS NULL AND v.deleted_at IS NULL
  ON CONFLICT(operation_key) DO NOTHING;
INSERT INTO jobs(id,kind,video_id,operation_key)
  SELECT 'migration:comments:index:'||c.video_id,'index',c.video_id,'migration:comments:index:'||c.video_id FROM comments c JOIN videos v ON v.id=c.video_id WHERE v.deleted_at IS NULL GROUP BY c.video_id ON CONFLICT(operation_key) DO NOTHING;
UPDATE jobs SET status='succeeded',lease_until=NULL,result=COALESCE(result,'{}'::jsonb)||'{"migratedToComments":true}'::jsonb,updated_at=now() WHERE kind='slack_reactions' AND status<>'succeeded';
ALTER TABLE slack_threads DROP COLUMN IF EXISTS reaction_summary_ts;
COMMIT;
