import '../styles/home.css'

/**
 * The public front door.
 *
 * The logo still leads to /admin, which the Worker forwards to the back
 * office — anyone without a session lands on Google sign-in there. It is an
 * unmarked door on purpose: a visitor has no reason to notice it.
 */
export function HomePage() {
  return (
    <main class="home">
      <a class="home-mark" href="/admin" aria-label="前往管理介面登入">
        <img src="/assets/luma-studio-logo.png" alt="苒光繪誌" />
      </a>
      <h1 class="home-greeting">歡迎來到苒光繪誌</h1>
      <p class="home-links">
        <a href="/shop">看看商品</a>
      </p>
    </main>
  )
}
