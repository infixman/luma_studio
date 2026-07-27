import '../styles/home.css'

/**
 * The public front door. The logo is the only control: it leads to /admin,
 * which sends anyone without a session to Google sign-in.
 */
export function HomePage() {
  return (
    <main class="home">
      <a class="home-mark" href="/admin" aria-label="前往管理介面登入">
        <img src="/assets/luma-studio-logo.png" alt="苒光繪誌" />
      </a>
      <h1 class="home-greeting">歡迎來到苒光繪誌</h1>
    </main>
  )
}
