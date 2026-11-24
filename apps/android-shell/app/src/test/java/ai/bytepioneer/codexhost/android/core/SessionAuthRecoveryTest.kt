package ai.bytepioneer.codexhost.android.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAuthRecoveryTest {
    @Test fun `existing cookie can be refreshed on initial unauthorized response`() {
        assertTrue(SessionAuthRecovery.Ready.canRefreshAfterUnauthorized(nowMillis = 100))
    }

    @Test fun `a replacement cookie rejected before the page settles does not trigger a loop`() {
        val loading = SessionAuthRecovery.LoadingWithFreshCookie
        assertFalse(loading.canRefreshAfterUnauthorized(nowMillis = 90_000))
        val visible = loading.onPageVisible(nowMillis = 90_000)
        assertFalse(visible.canRefreshAfterUnauthorized(nowMillis = 90_000))
        assertFalse(visible.canRefreshAfterUnauthorized(nowMillis = 94_999))
    }

    @Test fun `a later 401 can refresh even when the session started with a missing cookie`() {
        val visible = SessionAuthRecovery.LoadingWithFreshCookie.onPageVisible(nowMillis = 1_000)
        val navigated = visible.onPageVisible(nowMillis = 5_999)
        assertTrue(navigated.canRefreshAfterUnauthorized(nowMillis = 6_000))
        assertTrue(navigated.canRefreshAfterUnauthorized(nowMillis = 60_000))
    }
}
