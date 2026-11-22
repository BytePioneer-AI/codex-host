package ai.bytepioneer.codexhost.android.core

internal sealed interface SessionAuthRecovery {
    data object Ready : SessionAuthRecovery
    data object LoadingWithFreshCookie : SessionAuthRecovery
    data class Settling(val visibleSinceMillis: Long) : SessionAuthRecovery

    fun onPageVisible(nowMillis: Long): SessionAuthRecovery = when (this) {
        LoadingWithFreshCookie -> Settling(nowMillis)
        else -> this
    }

    // A newly issued cookie that immediately fails must not trigger another reload loop.
    // Start the grace period at the first visible commit, not while the page is still loading.
    fun canRefreshAfterUnauthorized(nowMillis: Long): Boolean = when (this) {
        Ready -> true
        LoadingWithFreshCookie -> false
        is Settling -> nowMillis - visibleSinceMillis >= 5_000L
    }
}
