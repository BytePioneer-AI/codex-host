use url::Url;

const GENERATION_QUERY: &str = "desktopSessionGeneration";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Delivery {
    WaitingForWeb,
    Live,
    Url,
}

struct Pending {
    session_id: String,
    delivery: Delivery,
    document: Option<String>,
}

#[derive(Default)]
pub(super) struct SessionActivation {
    generation: u64,
    pending: Option<Pending>,
}

pub(super) enum Recovery {
    Probe(String),
    Navigate(Url),
}

impl SessionActivation {
    pub(super) fn queue(&mut self, session_id: String, live: bool) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.pending = Some(Pending {
            session_id,
            delivery: if live {
                Delivery::Live
            } else {
                Delivery::WaitingForWeb
            },
            document: None,
        });
        self.generation
    }

    pub(super) fn clear(&mut self) {
        self.pending = None;
    }

    pub(super) fn connect(&mut self, login: &mut Url) {
        if let Some(pending) = &mut self.pending {
            self.generation = self.generation.wrapping_add(1);
            pending.delivery = Delivery::Url;
            pending.document = None;
            login
                .query_pairs_mut()
                .append_pair("session", &pending.session_id)
                .append_pair(GENERATION_QUERY, &self.generation.to_string());
        }
    }

    pub(super) fn recover(&mut self, generation: u64, login: &Url) -> Option<Recovery> {
        let pending = self.pending.as_ref()?;
        if self.generation != generation || pending.delivery != Delivery::Live {
            return None;
        }
        if pending.document.is_some() {
            return Some(Recovery::Probe(wake_script(
                &login.origin().ascii_serialization(),
                generation,
            )));
        }
        // No page was granted this request. Switching generations also makes a late claim fail.
        let mut url = login.clone();
        self.connect(&mut url);
        Some(Recovery::Navigate(url))
    }

    pub(super) fn claim(&mut self, generation: u64, document: String) -> Option<String> {
        let pending = self.pending.as_mut()?;
        if self.generation != generation || pending.delivery == Delivery::WaitingForWeb {
            return None;
        }
        match &pending.document {
            Some(owner) if *owner != document => return None,
            None => pending.document = Some(document),
            _ => (),
        }
        Some(pending.session_id.clone())
    }

    pub(super) fn opened(&mut self, generation: u64, document: &str) {
        if self.generation == generation
            && self
                .pending
                .as_ref()
                .and_then(|target| target.document.as_deref())
                == Some(document)
        {
            self.clear();
        }
    }

    pub(super) fn allows_navigation(&self, url: &Url) -> Option<bool> {
        let mut pairs = url.query_pairs();
        let (_, generation) = pairs.find(|(name, _)| name == GENERATION_QUERY)?;
        Some(self.pending.as_ref().is_some_and(|pending| {
            pending.delivery == Delivery::Url
                && generation.parse::<u64>().ok() == Some(self.generation)
                && url
                    .query_pairs()
                    .any(|(name, value)| name == "session" && value == pending.session_id)
        }))
    }
}

pub(super) fn wake_script(origin: &str, generation: u64) -> String {
    let origin = serde_json::to_string(origin).expect("Web origin is a JSON string");
    format!(
        "if (location.origin === {origin}) window.__codexhostOpenDesktopSession?.('{generation}');"
    )
}
