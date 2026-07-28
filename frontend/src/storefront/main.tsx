import { render } from 'preact'

import { App } from './app'
import '../shared/styles/base.css'
// After base.css: this is the storefront's surface, and it overrides the
// background the two sites would otherwise share.
import './styles/surface.css'

const root = document.querySelector('#app')
if (root) render(<App />, root)
