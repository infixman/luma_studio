/**
 * What the updater has managed to do so far.
 *
 * In `shared/` rather than beside the updater itself: the preload is compiled
 * with the renderer, so a type it imports from `main/` is a file that project
 * does not include — and the shape is something both halves talk about anyway.
 */
export interface UpdateState {
  checking: boolean
  downloaded: boolean
  version: string
  error: string
}
