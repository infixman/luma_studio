// @vitest-environment happy-dom

/**
 * The sidebar, and the one thing it has to be: complete.
 *
 * It used to carry its own list of pages, written out by hand beside the routing
 * table. Five pages ended up reachable only by typing their URL — 線上課程,
 * 庫存品, 影片庫, 影片儲存空間 and 桌面上傳工具 — because adding a route and adding
 * a link were two separate acts and nothing noticed when only one happened.
 *
 * So the list is derived, and this is the test that says so. A page that belongs
 * to a group and is not in the sidebar is a page nobody can find.
 */

import { expect, test } from 'vitest'

import { groups } from './AdminNav'
import { ADMIN_ROUTES } from '../routes'

function linked(): string[] {
  return groups.flatMap((group) => [
    ...(group.href ? [group.href] : []),
    ...(group.items ?? []).map((item) => item.href),
  ])
}

test('every page that belongs to a group is in the sidebar', () => {
  const missing = ADMIN_ROUTES.filter(
    (route) => route.group !== null && !linked().includes(route.path),
  )

  expect(missing.map((route) => route.label)).toEqual([])
})

test('the pages with no group are the ones reached from somewhere else', () => {
  /** 總覽 is the sidebar's own first row. Nothing else may opt out of being
   *  findable by having no group. */
  const ungrouped = ADMIN_ROUTES.filter((route) => route.group === null)

  expect(ungrouped.map((route) => route.id)).toEqual(['dashboard'])
})

test('every sidebar link points at a route that exists', () => {
  const paths = ADMIN_ROUTES.map((route) => route.path)

  for (const href of linked()) expect(paths).toContain(href)
})

test('each link has an icon of its own', () => {
  /** A row with no icon is a row that reads as a mistake, and the sidebar is
   *  scanned by shape long before it is read. */
  for (const group of groups) {
    expect(group.icon).toBeTruthy()
    for (const item of group.items ?? []) expect(item.icon).toBeTruthy()
  }
})

test('the labels are the ones the routing table gives', () => {
  /** Two names for one page is how a screen ends up being called something
   *  different in the place people look for it. */
  const byPath = new Map(ADMIN_ROUTES.map((route) => [route.path, route.label]))

  for (const group of groups) {
    for (const item of group.items ?? []) expect(item.label).toBe(byPath.get(item.href))
  }
})
