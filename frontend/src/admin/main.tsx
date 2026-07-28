import { render } from 'preact'

import { App } from './app'
import { startTheme } from './lib/theme'
import '../shared/styles/base.css'
// After base.css: the tokens are what the back office is actually painted
// with, and they override the two colours base.css sets for both sites.
import './styles/tokens.css'
import './styles/admin.css'

// Before the first render, so the page is already the right colour rather
// than painting light and correcting itself a frame later.
startTheme()

const root = document.querySelector('#app')
if (root) render(<App />, root)
