// Hermes v0.23.3 moved session storage to persistence_assembly. Keep the
// native storage API differences here so both gateway helpers use the same store.
export const GATEWAY_STORAGE_SCRIPT = String.raw`
try:
    from hermes_state_ids import new_session_id
except ModuleNotFoundError as exc:
    if exc.name != 'hermes_state_ids': raise
    from contextlib import ExitStack
    from persistence.conversation.messages import TranscriptRead, TranscriptView
    from persistence.conversation.sessions import (
        INTERNAL_LISTING_SOURCES, NewSession, SessionOrder, SessionQuery, SessionWindow,
    )
    from persistence_assembly import open_persistence, open_persistence_reader, profile_scope, store_location
    from session_rules.session_ids import new_session_id

    def default_db_path():
        return store_location(profile_scope())

    class SessionDB:
        def __init__(self, read_only=False):
            scope = profile_scope()
            self.db_path = store_location(scope)
            self.profile_dir = scope.profile_dir
            self.stack = ExitStack()
            handle = open_persistence_reader(scope.profile_dir) if read_only else open_persistence(scope)
            self.store = self.stack.enter_context(handle)

        def close(self):
            self.stack.close()

        def get_session(self, session_id):
            row = self.store.sessions.get(session_id)
            return None if row is None else row.as_session_row()

        def create_session(self, session_id, source, **kwargs):
            return self.store.sessions.create(NewSession(session_id=session_id, source=source, **kwargs))

        def get_messages(self, session_id, include_inactive=False):
            view = TranscriptView.ALL if include_inactive else TranscriptView.ACTIVE
            return [row.as_wire_row() for row in self.store.messages.read_transcript(session_id, TranscriptRead(view=view))]

        def export_session(self, session_id):
            from hermes_cli.session_export import to_legacy_export_dict
            exported = self.store.maintenance.export_session(session_id)
            return None if exported is None else to_legacy_export_dict(exported)

        def get_compression_lineage(self, session_id):
            return self.store.lineage.lineage(session_id)

        def resolve_resume_session_id(self, session_id):
            return self.store.lineage.resolve_resume_target(session_id)

        def import_sessions(self, sessions):
            result = self.store.maintenance.import_sessions(sessions)
            return {'imported_ids': list(result.imported_ids)}

        def update_session_tool_names(self, session_id, tools):
            self.store.sessions.update_tool_pin(session_id, tools)

        def delete_session(self, session_id, expected_delete_ids):
            from gateway.session_ingress_media import native_inputs_root
            from session_retention import after_sessions_removed
            removed = self.store.sessions.delete(session_id, expected_ids=expected_delete_ids,
                media_root=str(native_inputs_root()))
            after_sessions_removed(self.store, self.profile_dir, removed, reason='delete', primary=session_id)
            return bool(removed)

    def resume_display(db, session_id):
        return [message.as_openai_message() for message in db.store.messages.read_resume_conversations(session_id).display]

    def list_sessions(db, session_id, include_subagents):
        query = SessionQuery(order=SessionOrder.LAST_ACTIVE, exclude_sources=INTERNAL_LISTING_SOURCES,
            id_query=session_id, include_subagents=include_subagents)
        return [entry.as_list_row() for entry in db.store.sessions.list_sessions(query, SessionWindow(limit=None))]
else:
    from hermes_state import SessionDB, _default_db_path as default_db_path
    from hermes_state_sessions import INTERNAL_LISTING_SOURCES

    def resume_display(db, session_id):
        return db.get_resume_conversations(session_id)[1]

    def list_sessions(db, session_id, include_subagents):
        return db.list_sessions_rich(limit=-1, order_by_last_active=True,
            exclude_sources=list(INTERNAL_LISTING_SOURCES), id_query=session_id, include_subagents=include_subagents)
`;
