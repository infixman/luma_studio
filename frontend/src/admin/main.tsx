import { render } from 'preact'

import { App } from './app'
import '../shared/styles/base.css'

const root = document.querySelector('#app')
if (root) render(<App />, root)
