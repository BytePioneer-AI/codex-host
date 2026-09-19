// Use the installed native storage API regardless of the reported release/contract;
// never rewrite the source transcript or send a model prompt to derive history.
export const GATEWAY_HISTORY_SCRIPT = String.raw`
import sys
output = sys.stdout
sys.stdout = sys.stderr
import hashlib, json, sqlite3
from pathlib import Path
from urllib.parse import quote
from tui_gateway.server import _history_to_messages
from agent.context_compressor import user_originated_turn_view
from hermes_state import SessionDB
from hermes_state_ids import new_session_id
p = json.load(sys.stdin)
sid = p['sessionId']
public_sid = sid

class HistoryFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

def digest(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()

def config(value):
    return json.loads(value) if isinstance(value, str) else dict(value or {})

def user_text(row):
    view = user_originated_turn_view(row)
    if view is None: return None
    # Use the original display kind for native /steer and skill rendering; the
    # origin predicate above separately excludes synthetic continuation turns.
    projected = _history_to_messages([row])
    if not projected: return None
    return projected[0].get('text')

def capture(db):
    exported = db.export_session(sid)
    if exported is None:
        raise RuntimeError('Hermes session is not persisted')
    active = exported['messages']
    lineage = db.get_compression_lineage(sid)
    if not lineage: raise RuntimeError('Hermes session lineage is missing')
    _, display = db.get_resume_conversations(sid)
    # get_resume_conversations preserves tool relations but sanitizes display text.
    # Read the same native rows verbatim and native display identities through a
    # separate mode=ro connection; MIN(id) preserves identity across tail cloning.
    uri = 'file:' + quote(str(Path(db.db_path).resolve()), safe='/') + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = []
        native_rows = {}
        for msg in display:
            row = conn.execute('SELECT * FROM messages WHERE id = ?', (msg['_row_id'],)).fetchone()
            if row is None:
                raise RuntimeError('Hermes history changed while reading')
            owner = row['session_id']
            if owner not in native_rows:
                native_rows[owner] = {r['id']: r for r in db.get_messages(owner, include_inactive=True)}
            raw = dict(native_rows[owner][row['id']])
            original = row['id']
            if row['display_identity'] is not None:
                original = conn.execute('SELECT MIN(id) FROM messages WHERE session_id IN (' + ','.join('?' for _ in lineage) + ') AND display_identity = ?',
                    (*lineage, row['display_identity'])).fetchone()[0] or row['id']
            raw['original_id'] = original
            if raw['role'] == 'user': raw['user_text'] = user_text(raw)
            elif raw['role'] == 'assistant':
                visible = _history_to_messages([raw])
                raw['display_text'] = visible[0].get('text', '') if visible else ''
                raw['display_visible'] = bool(visible)
            rows.append(raw)
        compressed = conn.execute('SELECT 1 FROM messages WHERE session_id = ? AND (compacted = 1 OR _compressed_summary = 1) LIMIT 1', (sid,)).fetchone() is not None
    current = db.export_session(sid)
    if current is None or digest(current['messages']) != digest(active):
        raise RuntimeError('Hermes history changed while reading')
    derivable = sid == public_sid and len(lineage) == 1 and not compressed and [r['id'] for r in rows] == [r['id'] for r in active]
    boundaries = {}
    if derivable:
        for i, row in enumerate(active):
            if user_text(row) is None: continue
            end = next((j for j in range(i + 1, len(active)) if user_text(active[j]) is not None), len(active))
            boundaries[str(row['id'])] = {'count': end, 'digest': digest(active[:end])}
    return exported, {'rows': rows, 'derivable': derivable, 'boundaries': boundaries, 'physicalSessionId': sid}

try:
    if p['operation'] == 'ensure':
        db = SessionDB()
        try:
            if db.get_session(sid) is None:
                from hermes_constants import parse_reasoning_effort
                initial = {}
                if isinstance(p.get('provider'), str) and p['provider']: initial['provider'] = p['provider']
                if isinstance(p.get('model'), str) and p['model']: initial['model'] = p['model']
                if isinstance(p.get('reasoningEffort'), str):
                    reasoning = parse_reasoning_effort(p['reasoningEffort'])
                    if reasoning is not None: initial['reasoning_config'] = reasoning
                if isinstance(p.get('yolo'), bool): initial['yolo_mode'] = p['yolo']
                db.create_session(session_id=sid, source='cli', cwd=p['cwd'], model=p.get('model'), model_config=initial)
            result = {'created': True}
        finally: db.close()
    elif p['operation'] == 'discard':
        child = p['derivedSessionId']
        result = {'deleted': False}
        if child == sid: raise HistoryFailure('invalidState', 'Cannot delete the source Hermes session')
        db = SessionDB()
        try:
            row = db.get_session(child)
            if (row is not None and row.get('parent_session_id') == sid
                    and config(row.get('model_config')).get('_branched_from') == sid
                    and digest(db.get_messages(child)) == p['expectedDigest']):
                result['deleted'] = db.delete_session(child, expected_delete_ids=[child])
        finally: db.close()
    else:
        db = SessionDB(read_only=True)
        try:
            sid = db.resolve_resume_session_id(public_sid)
            exported, snapshot = capture(db)
        finally: db.close()
        if p['operation'] in ('read', 'resolve'):
            result = snapshot
        elif p['operation'] == 'derive':
            if not snapshot['derivable']:
                raise HistoryFailure('unsupported', 'Hermes cannot losslessly derive compacted or inherited history')
            messages = exported['messages']
            if p.get('rollbackLastTurn'):
                users = [i for i, row in enumerate(messages) if user_text(row) is not None]
                if not users: raise HistoryFailure('invalidState', 'Hermes session has no user turn to roll back')
                messages = messages[:users[-1]]
            elif p.get('checkpoint'):
                checkpoint = p['checkpoint']
                boundary = snapshot['boundaries'].get(checkpoint['checkpointId'])
                if boundary is None or boundary != checkpoint.get('locator'):
                    raise HistoryFailure('checkpointNotFound', 'Hermes checkpoint no longer matches native history')
                messages = messages[:boundary['count']]
            child = new_session_id()
            model_config = config(exported.get('model_config'))
            model_config['_branched_from'] = sid
            payload = {**exported, 'id': child, 'parent_session_id': sid, 'model_config': model_config,
                'messages': messages, 'title': None, 'ended_at': None, 'end_reason': None, 'archived': False}
            db = SessionDB()
            imported = False
            try:
                result = db.import_sessions([payload])
                if result.get('imported_ids') != [child]:
                    raise RuntimeError('Hermes native import did not create the derived session')
                imported = True
                # Native import resets ownership. Fill this NEW row only through the
                # native COALESCE upsert, preserving source profile and working dir.
                db.create_session(session_id=child, source=exported.get('source') or 'cli',
                    cwd=exported.get('cwd'), profile_name=exported.get('profile_name'), parent_session_id=sid)
                tools = exported.get('tool_names')
                if isinstance(tools, str): tools = json.loads(tools)
                if tools is not None: db.update_session_tool_names(child, tools)
                copied = db.get_messages(child)
                def payload_rows(rows):
                    ignored = {'id', 'session_id', 'active', 'compacted', '_row_id'}
                    result = []
                    for row in rows:
                        row = {k: v for k, v in row.items() if k not in ignored}
                        for key in ('reasoning_details', 'codex_reasoning_items', 'codex_message_items'):
                            if isinstance(row.get(key), str): row[key] = json.loads(row[key])
                        result.append(row)
                    return result
                if payload_rows(copied) != payload_rows(messages):
                    raise RuntimeError('Hermes native import did not preserve the transcript')
                result = {'sessionId': child, 'digest': digest(copied)}
            except Exception:
                if imported: db.delete_session(child, expected_delete_ids=[child])
                raise
            finally: db.close()
        else: raise RuntimeError('Unknown Hermes history operation')
except HistoryFailure as exc:
    result = {'error': {'code': exc.code, 'message': str(exc)}}
print(json.dumps(result, ensure_ascii=True), file=output)
`;
