use url::Url;

const GENERATION_QUERY: &str = "desktopSessionGeneration";

#[derive(PartialEq, Eq)]
enum Delivery {
    WaitingForWeb,
    Live,
    LoginUrl,
    AfterLogin,
    LoginFailed,
    Url,
    PreviousDocument,
}

struct Pending {
    generation: u64,
    session_id: String,
    delivery: Delivery,
    document: Option<String>,
    unconfirmed: bool,
    discarding: bool,
}

impl Pending {
    fn apply_to(&self, login: &mut Url) {
        login
            .query_pairs_mut()
            .append_pair("session", &self.session_id)
            .append_pair(GENERATION_QUERY, &self.generation.to_string());
    }
}

struct Candidate {
    target: Pending,
    destination: Option<Url>,
    admitted: bool,
}

struct LoginNavigation {
    generation: u64,
    url: Url,
    expired: bool,
    #[cfg(any(windows, test))]
    native_id: Option<u64>,
    #[cfg(any(windows, test))]
    expected: bool,
}

impl LoginNavigation {
    fn authenticated_url(&self, url: &Url) -> bool {
        self.url.origin() == url.origin()
            && self.url.path() == url.path()
            && self.url.fragment() == url.fragment()
            && self
                .url
                .query_pairs()
                .filter(|(name, _)| name != "token")
                .eq(url.query_pairs())
    }

    #[cfg(any(windows, test))]
    fn manual_return_url(&self) -> Url {
        let mut url = self.url.clone();
        url.set_fragment(None);
        url.query_pairs_mut()
            .clear()
            .extend_pairs(self.url.query_pairs().filter(|(name, _)| name != "token"));
        url
    }
}

#[derive(Default)]
pub(super) struct SessionActivation {
    generation: u64,
    pending: Option<Pending>,
    candidate: Option<Candidate>,
    login_navigation: Option<LoginNavigation>,
    login_failed: bool,
    #[cfg(any(windows, test))]
    manual_login_return: Option<Url>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Admission {
    Accepted,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Scheduling {
    Scheduled,
    NotScheduled,
    Unknown,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativeLoginCompletion {
    Loaded,
    Rejected,
    TransportFailed,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SessionReceipt {
    Confirmed,
    Retry,
    Unavailable,
}

pub(super) enum Abandon {
    Unclaimed,
    AwaitDocument,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum SessionClaim {
    Granted { session_id: String },
    Wake { generation: String },
    Discard { generation: String },
    Retry,
    Unavailable,
}

impl SessionActivation {
    fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    pub(super) fn stage(&mut self, session_id: String, live: bool) -> Option<u64> {
        if self.has_claim()
            || self.candidate.is_some()
            || (self.pending.is_some() && self.login_in_flight())
        {
            return None;
        }
        let generation = self.next_generation();
        self.candidate = Some(Candidate {
            target: Pending {
                generation,
                session_id,
                delivery: if self.login_in_flight() {
                    Delivery::AfterLogin
                } else if live {
                    Delivery::Live
                } else {
                    Delivery::WaitingForWeb
                },
                document: None,
                unconfirmed: false,
                discarding: false,
            },
            destination: None,
            admitted: false,
        });
        Some(generation)
    }

    pub(super) fn stage_url(&mut self, generation: u64, mut url: Url) -> Option<Url> {
        let candidate = self.candidate.as_mut()?;
        if generation != candidate.target.generation {
            return None;
        }
        // The live service already has a cookie; do not replay its login token.
        url.set_query(None);
        candidate.target.apply_to(&mut url);
        candidate.target.delivery = Delivery::Url;
        candidate.destination = Some(url.clone());
        Some(url)
    }

    pub(super) fn finish(&mut self, generation: u64, scheduling: Scheduling) -> Admission {
        if !self
            .candidate
            .as_ref()
            .is_some_and(|entry| entry.target.generation == generation)
        {
            return Admission::Unknown;
        }
        let candidate = self.candidate.take().unwrap();
        if scheduling == Scheduling::Scheduled {
            self.pending = Some(candidate.target);
            Admission::Accepted
        } else if candidate.admitted || scheduling == Scheduling::Unknown {
            if candidate.admitted
                && let Some(target) = &mut self.pending
                && target.delivery == Delivery::Url
                && target.document.is_none()
            {
                // The admitted navigation may replace the only bridge holding A's deep link.
                target.delivery = Delivery::Live;
            }
            Admission::Unknown
        } else {
            Admission::Rejected
        }
    }

    pub(super) fn clear_unclaimed(&mut self) {
        self.candidate = None;
        self.reset_login();
        if !self.has_claim() {
            self.pending = None;
        }
    }

    pub(super) fn web_disconnected(&mut self) {
        self.candidate = None;
        self.reset_login();
        self.suspend_unclaimed_delivery();
    }

    fn reset_login(&mut self) {
        self.login_navigation = None;
        self.login_failed = false;
        #[cfg(any(windows, test))]
        {
            self.manual_login_return = None;
        }
    }

    fn suspend_unclaimed_delivery(&mut self) {
        if let Some(target) = self.pending.as_mut()
            && target.document.is_none()
            && target.delivery != Delivery::LoginFailed
        {
            target.delivery = Delivery::WaitingForWeb;
        }
    }

    pub(super) fn has_claim(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|target| target.document.is_some())
    }

    pub(super) fn is_discarding(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|target| target.discarding)
    }

    pub(super) fn login_in_flight(&self) -> bool {
        self.login_navigation
            .as_ref()
            .is_some_and(|nav| !nav.expired)
    }

    pub(super) fn login_needs_retry(&self) -> bool {
        self.login_failed
            || self
                .pending
                .as_ref()
                .is_some_and(|target| target.delivery == Delivery::LoginFailed)
            || self
                .login_navigation
                .as_ref()
                .is_some_and(|nav| nav.expired)
    }

    pub(super) fn expire_login(&mut self, generation: u64) {
        if let Some(nav) = self
            .login_navigation
            .as_mut()
            .filter(|nav| nav.generation == generation)
        {
            // Keep admitting a valid late redirect until another navigation supersedes it.
            nav.expired = true;
        }
    }

    pub(super) fn defer_login(&mut self, generation: u64) -> bool {
        if !self
            .login_navigation
            .as_ref()
            .is_some_and(|nav| nav.generation == generation)
        {
            return false;
        }
        self.login_navigation = None;
        self.login_failed = true;
        self.suspend_unclaimed_delivery();
        true
    }

    fn finish_login(&mut self, generation: u64, authenticated: bool) -> bool {
        if !self
            .login_navigation
            .as_ref()
            .is_some_and(|nav| nav.generation == generation)
        {
            return false;
        }
        self.login_navigation = None;
        self.login_failed = !authenticated;
        if !authenticated {
            self.reject_login_target();
        } else if let Some(target) = self.pending.as_mut() {
            match target.delivery {
                Delivery::LoginUrl => target.delivery = Delivery::Url,
                Delivery::AfterLogin => target.delivery = Delivery::Live,
                _ => (),
            }
        }
        true
    }

    fn reject_login_target(&mut self) {
        if let Some(target) = self.pending.as_mut()
            && matches!(target.delivery, Delivery::LoginUrl | Delivery::AfterLogin)
        {
            target.delivery = Delivery::LoginFailed;
        }
    }

    #[cfg(any(windows, test))]
    pub(super) fn native_login_allows(&mut self, id: u64, url: &Url, redirected: bool) -> bool {
        let Some(nav) = &mut self.login_navigation else {
            return true;
        };
        if !redirected && nav.native_id.is_none() && nav.url == *url {
            nav.native_id = Some(id);
            return true;
        }
        if nav.native_id != Some(id) {
            return true;
        }
        nav.expected = redirected && nav.authenticated_url(url);
        nav.expected
    }

    #[cfg(any(not(windows), test))]
    pub(super) fn portable_login_allows(&mut self, url: &Url) -> bool {
        let Some(nav) = &mut self.login_navigation else {
            return true;
        };
        if nav.url == *url || nav.authenticated_url(url) {
            return true;
        }
        let ordinary = (nav.expired || self.pending.is_none())
            && nav.url.origin() == url.origin()
            && url.username().is_empty()
            && url.password().is_none()
            && !url
                .query_pairs()
                .any(|(name, _)| name == "token" || name == GENERATION_QUERY);
        if ordinary {
            // A normal same-origin navigation can supersede authentication,
            // but the stale redirect still must not reach the system browser.
            nav.expired = true;
            if let Some(target) = self.pending.as_mut()
                && target.delivery == Delivery::AfterLogin
            {
                target.delivery = Delivery::LoginFailed;
            }
        }
        ordinary
    }

    #[cfg(any(windows, test))]
    pub(super) fn native_login_completed(
        &mut self,
        id: u64,
        result: NativeLoginCompletion,
    ) -> bool {
        let Some(nav) = self
            .login_navigation
            .as_ref()
            .filter(|nav| nav.native_id == Some(id))
        else {
            return false;
        };
        let generation = nav.generation;
        let authenticated = result == NativeLoginCompletion::Loaded && nav.expected;
        if !authenticated {
            // This URL can load the home page, but is no longer an activation handshake.
            self.manual_login_return = Some(nav.manual_return_url());
        }
        match result {
            NativeLoginCompletion::TransportFailed => self.defer_login(generation),
            _ => self.finish_login(generation, authenticated),
        }
    }

    #[cfg(any(not(windows), test))]
    pub(super) fn portable_login_loaded(&mut self, url: &Url) -> bool {
        let Some(nav) = self.login_navigation.as_mut() else {
            return false;
        };
        if nav.url == *url {
            // A committed token page is not the server's token-stripping redirect.
            // Keep admitting the return to the home page after manual sign-in.
            nav.expired = true;
            self.reject_login_target();
            return true;
        }
        let generation = nav.generation;
        nav.authenticated_url(url) && self.finish_login(generation, true)
    }

    pub(super) fn connect(&mut self, login: &mut Url) -> Option<u64> {
        self.candidate = None;
        self.reset_login();
        let target = self.pending.as_mut()?;
        if target.document.is_some() {
            target.delivery = Delivery::PreviousDocument;
            return None;
        }
        if target.delivery == Delivery::LoginFailed {
            return None;
        }
        self.generation += 1;
        target.generation = self.generation;
        target.delivery = Delivery::LoginUrl;
        target.unconfirmed = false;
        target.apply_to(login);
        self.login_navigation = Some(LoginNavigation {
            generation: target.generation,
            url: login.clone(),
            expired: false,
            #[cfg(any(windows, test))]
            native_id: None,
            #[cfg(any(windows, test))]
            expected: false,
        });
        Some(target.generation)
    }

    pub(super) fn ready(&self, document: &str) -> SessionClaim {
        if let Some(target) = &self.pending {
            if target.discarding && target.document.as_deref() == Some(document) {
                return SessionClaim::Discard {
                    generation: target.generation.to_string(),
                };
            }
            if target.delivery == Delivery::AfterLogin {
                return SessionClaim::Retry;
            }
            if target.delivery == Delivery::Live
                && target
                    .document
                    .as_deref()
                    .is_none_or(|owner| owner == document)
            {
                return SessionClaim::Wake {
                    generation: target.generation.to_string(),
                };
            }
        }
        SessionClaim::Unavailable
    }

    pub(super) fn claim(&mut self, generation: u64, document: String) -> SessionClaim {
        if self
            .candidate
            .as_ref()
            .is_some_and(|entry| entry.target.generation == generation)
        {
            return SessionClaim::Retry;
        }
        if self.pending.as_ref().is_some_and(|target| {
            target.generation == generation && target.delivery == Delivery::AfterLogin
        }) {
            return SessionClaim::Retry;
        }
        let Some(target) = self
            .pending
            .as_mut()
            .filter(|target| target.generation == generation)
        else {
            return SessionClaim::Unavailable;
        };
        if matches!(
            target.delivery,
            Delivery::WaitingForWeb | Delivery::PreviousDocument | Delivery::LoginFailed
        ) {
            return SessionClaim::Unavailable;
        }
        if target.discarding {
            return SessionClaim::Unavailable;
        }
        match &target.document {
            Some(owner) if *owner != document => return SessionClaim::Unavailable,
            None if self.candidate.is_some() => return SessionClaim::Retry,
            None => target.document = Some(document),
            _ => (),
        }
        SessionClaim::Granted {
            session_id: target.session_id.clone(),
        }
    }

    pub(super) fn receipt(
        &mut self,
        generation: u64,
        document: &str,
        discarded: bool,
        page_current: bool,
    ) -> SessionReceipt {
        let Some(target) = self.pending.as_ref().filter(|target| {
            target.generation == generation && target.document.as_deref() == Some(document)
        }) else {
            return SessionReceipt::Unavailable;
        };
        if !page_current || (target.discarding && !discarded) {
            return SessionReceipt::Retry;
        }
        if discarded && !target.discarding {
            return SessionReceipt::Unavailable;
        }
        self.pending = None;
        SessionReceipt::Confirmed
    }

    // URL wakes are restricted to the bridge that received that deep link. A
    // wake issued just after navigate() must not let the previous page claim it.
    pub(super) fn wake_url_only(&self, generation: u64) -> Option<bool> {
        let target = self
            .pending
            .as_ref()
            .filter(|target| target.generation == generation)?;
        match target.delivery {
            Delivery::Live => Some(false),
            Delivery::LoginUrl | Delivery::Url => Some(true),
            _ => None,
        }
    }

    pub(super) fn pending_generation(&self) -> Option<u64> {
        self.pending.as_ref().map(|target| target.generation)
    }

    pub(super) fn mark_unconfirmed(&mut self, generation: u64) {
        if let Some(target) = self
            .pending
            .as_mut()
            .filter(|target| target.generation == generation)
        {
            target.unconfirmed = true;
        }
    }

    pub(super) fn is_unconfirmed(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|target| target.unconfirmed)
    }

    pub(super) fn abandon_unconfirmed(&mut self) -> Option<Abandon> {
        let target = self.pending.as_mut().filter(|target| target.unconfirmed)?;
        if target.document.is_some() {
            target.discarding = true;
            Some(Abandon::AwaitDocument)
        } else {
            self.pending = None;
            Some(Abandon::Unclaimed)
        }
    }

    pub(super) fn allows_navigation(&mut self, url: &Url, admit: bool) -> Option<bool> {
        let (_, generation) = url
            .query_pairs()
            .find(|(name, _)| name == GENERATION_QUERY)?;
        if let Some(login) = &self.login_navigation
            && (login.url == *url || login.authenticated_url(url))
        {
            return Some(true);
        }
        #[cfg(any(windows, test))]
        if self.manual_login_return.as_ref() == Some(url) {
            return Some(true);
        }
        if let Some(candidate) = &mut self.candidate
            && candidate.destination.as_ref() == Some(url)
        {
            candidate.admitted |= admit;
            return Some(true);
        }
        Some(self.pending.as_ref().is_some_and(|target| {
            matches!(target.delivery, Delivery::LoginUrl | Delivery::Url)
                && generation.parse::<u64>().ok() == Some(target.generation)
                && url
                    .query_pairs()
                    .any(|(name, value)| name == "session" && value == target.session_id)
        }))
    }
}

pub(super) fn wake_script(origin: &str, generation: u64, url_only: bool) -> String {
    let origin = serde_json::to_string(origin).expect("Web origin is a JSON string");
    format!(
        "if (location.origin === {origin}) window.__codexhostOpenDesktopSession?.('{generation}', {url_only});"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_login_distinguishes_late_completion_from_supersession() {
        let login = Url::parse("http://[::1]:4400/?token=fixture").unwrap();
        let ordinary = Url::parse("http://[::1]:4400/settings?tab=general").unwrap();
        let external = Url::parse("https://example.test/").unwrap();
        let different_port = Url::parse("http://[::1]:4401/").unwrap();
        let stale_session =
            Url::parse("http://[::1]:4400/?session=stale&desktopSessionGeneration=99").unwrap();
        let unexpected_token = Url::parse("http://[::1]:4400/settings?token=fixture").unwrap();

        for (expired, redirect_before_recovery) in [(true, false), (true, true), (false, false)] {
            let mut session = SessionActivation::default();
            let a = session.stage("A".into(), false).unwrap();
            assert_eq!(
                session.finish(a, Scheduling::Scheduled),
                Admission::Accepted
            );
            let mut initial = login.clone();
            let a = session.connect(&mut initial).unwrap();
            let redirect = Url::parse(&format!(
                "http://[::1]:4400/?session=A&desktopSessionGeneration={a}"
            ))
            .unwrap();

            assert!(session.portable_login_allows(&initial));
            assert!(session.portable_login_allows(&redirect));
            assert!(!session.portable_login_allows(&ordinary));
            assert!(!session.portable_login_allows(&external));

            session.mark_unconfirmed(a);
            assert!(matches!(
                session.abandon_unconfirmed(),
                Some(Abandon::Unclaimed)
            ));
            let b = session.stage("B".into(), true).unwrap();
            assert_eq!(
                session.finish(b, Scheduling::Scheduled),
                Admission::Accepted
            );
            assert_eq!(session.claim(b, "old-page".into()), SessionClaim::Retry);
            if expired {
                session.expire_login(a);
            } else {
                session.mark_unconfirmed(b);
                assert!(matches!(
                    session.abandon_unconfirmed(),
                    Some(Abandon::Unclaimed)
                ));
            }

            if redirect_before_recovery {
                assert!(session.portable_login_allows(&redirect));
                assert!(session.portable_login_loaded(&redirect));
                assert_eq!(
                    session.ready("late-page"),
                    SessionClaim::Wake {
                        generation: b.to_string()
                    }
                );
                assert_eq!(
                    session.claim(b, "late-page".into()),
                    SessionClaim::Granted {
                        session_id: "B".into()
                    }
                );
                continue;
            }
            assert!(session.portable_login_allows(&ordinary));
            assert_eq!(session.ready("old-page"), SessionClaim::Unavailable);
            assert_eq!(
                session.claim(b, "old-page".into()),
                SessionClaim::Unavailable
            );
            assert!(!session.portable_login_allows(&external));
            assert!(!session.portable_login_allows(&different_port));
            assert!(!session.portable_login_allows(&stale_session));
            assert!(!session.portable_login_allows(&unexpected_token));
            assert!(!session.portable_login_loaded(&ordinary));
            assert!(session.portable_login_allows(&redirect));
            assert!(session.portable_login_loaded(&redirect));
            assert_eq!(session.ready("old-page"), SessionClaim::Unavailable);
            assert_eq!(
                session.claim(b, "old-page".into()),
                SessionClaim::Unavailable
            );
            assert_eq!(
                session.claim(b, "late-page".into()),
                SessionClaim::Unavailable
            );
            assert_eq!(session.pending_generation(), expired.then_some(b));
            assert_eq!(session.connect(&mut login.clone()), None);
        }
    }

    #[test]
    fn portable_replacement_blocks_stale_redirects_before_its_first_hop() {
        let login = Url::parse("http://[::1]:4400/?token=fixture").unwrap();
        let ordinary = Url::parse("http://[::1]:4400/settings").unwrap();
        let external = Url::parse("https://example.test/").unwrap();
        let unexpected_token = Url::parse("http://[::1]:4400/?token=unexpected").unwrap();
        let mut session = SessionActivation::default();
        let reserve_login = |session: &mut SessionActivation, id: &str| {
            let generation = session.stage(id.into(), false).unwrap();
            assert_eq!(
                session.finish(generation, Scheduling::Scheduled),
                Admission::Accepted
            );
            let mut initial = login.clone();
            let generation = session.connect(&mut initial).unwrap();
            let redirect = Url::parse(&format!(
                "http://[::1]:4400/?session={id}&desktopSessionGeneration={generation}"
            ))
            .unwrap();
            (generation, initial, redirect)
        };

        let (a, first_hop, old_redirect) = reserve_login(&mut session, "A");
        assert!(session.portable_login_allows(&first_hop));
        session.expire_login(a);
        assert!(session.portable_login_allows(&ordinary));

        let (b, new_first_hop, new_redirect) = reserve_login(&mut session, "B");
        assert!(!session.portable_login_allows(&external));
        assert!(!session.portable_login_allows(&unexpected_token));
        assert!(!session.portable_login_allows(&old_redirect));
        assert!(!session.portable_login_loaded(&old_redirect));
        assert!(!session.portable_login_allows(&ordinary));

        assert!(session.portable_login_allows(&new_first_hop));
        assert!(session.portable_login_allows(&new_redirect));
        assert!(session.portable_login_loaded(&new_redirect));
        assert!(session.portable_login_allows(&ordinary));
        assert_eq!(
            session.claim(a, "old-page".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            session.claim(b, "new-page".into()),
            SessionClaim::Granted {
                session_id: "B".into()
            }
        );
    }

    #[test]
    fn portable_committed_token_page_cannot_be_replayed_by_sign_in_or_reconnect() {
        let login = Url::parse("http://127.0.0.1:4400/?token=fixture").unwrap();
        for join_before_rejection in [false, true] {
            let mut session = SessionActivation::default();
            let a = session.stage("A".into(), false).unwrap();
            assert_eq!(
                session.finish(a, Scheduling::Scheduled),
                Admission::Accepted
            );
            let mut first_hop = login.clone();
            let a = session.connect(&mut first_hop).unwrap();
            let sign_in_return = Url::parse(&format!(
                "http://127.0.0.1:4400/?session=A&desktopSessionGeneration={a}"
            ))
            .unwrap();
            assert!(session.portable_login_allows(&first_hop));
            let target = if join_before_rejection {
                session.mark_unconfirmed(a);
                assert!(matches!(
                    session.abandon_unconfirmed(),
                    Some(Abandon::Unclaimed)
                ));
                let b = session.stage("B".into(), true).unwrap();
                assert_eq!(
                    session.finish(b, Scheduling::Scheduled),
                    Admission::Accepted
                );
                b
            } else {
                a
            };

            assert!(session.portable_login_loaded(&first_hop));
            assert!(session.login_needs_retry());
            assert!(!session.login_in_flight());
            assert!(session.portable_login_allows(&sign_in_return));
            assert!(session.portable_login_loaded(&sign_in_return));
            assert_eq!(
                session.ready("page-after-sign-in"),
                SessionClaim::Unavailable
            );
            assert_eq!(
                session.claim(target, "page-after-sign-in".into()),
                SessionClaim::Unavailable
            );
            session.web_disconnected();
            let mut reconnect = login.clone();
            assert_eq!(session.connect(&mut reconnect), None);
            assert_eq!(reconnect, login);
        }
    }
}
