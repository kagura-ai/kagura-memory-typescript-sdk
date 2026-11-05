"""Run from the repo root with kagura-memory==0.44.0 and click==8.3.3."""
import importlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from click.testing import CliRunner
from kagura_memory.cli import main
from kagura_memory.auth.credentials import OAuthCredentials, CredentialsFile

cli = importlib.import_module('kagura_memory.auth.cli')
credentials = importlib.import_module('kagura_memory.auth.credentials')
now = datetime(2026, 11, 5, tzinfo=UTC)
class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return now if tz is None else now.astimezone(tz)

rows = []
for seconds, refresh_token in [(3600, True), (301, True), (300, True), (299, True),
                                (-1, True), (3600, False), (299, False), (-1, False),
                                (90061, True), (3600.123, True)]:
    creds = OAuthCredentials(server='https://x.test', mcp_url='https://x.test/mcp',
        client_id='kagura-cli', access_token='atok-1', refresh_token='rtok-1' if refresh_token else '',
        token_type='Bearer', expires_at=now+timedelta(seconds=seconds), scope='memory:read memory:write',
        workspace_id='ws-1', workspace_name='Acme', user_email='test@example.com', issued_at=now)
    calls = []
    async def refresh(target, current, *, expected_stale_token):
        calls.append(dict(target=target, expected_stale_token=expected_stale_token))
        if not current.refresh_token:
            # Actual Python validation/message, before it creates an HTTP client.
            return await credentials._network_refresh(current, scope=None)
        return SimpleNamespace(credentials=current.with_refreshed(access_token='atok-2',
            expires_at=now+timedelta(seconds=3600)), refreshed=True)
    with patch.object(cli, 'load_credentials_file', return_value=CredentialsFile(profiles={'default':creds})), \
         patch.object(cli, '_run_refresh', side_effect=refresh), \
         patch.object(cli, 'datetime', Clock), patch.object(credentials, 'datetime', Clock):
        result = CliRunner().invoke(main, ['auth','token'], prog_name='kagura-memory')
    rows.append(dict(seconds=seconds, refreshToken=refresh_token, code=result.exit_code,
        stdout=result.stdout, stderr=result.stderr, refreshCalls=calls))
Path('test/cli/authToken112.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
