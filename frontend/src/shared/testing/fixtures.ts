/**
 * Shapes for tests, built once.
 *
 * A test that spells out every field of a Course is a test that has to be
 * edited whenever one is added — and the edit is never interesting, so it
 * gets done carelessly. These take the fields a test actually cares about
 * and fill in the rest.
 */

import type { Course, InventoryItem } from '../types'

export function aCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: 'course-1',
    slug: 'watercolour',
    title: '水彩花卉入門',
    status: 'published',
    summary: '兩小時學會水彩花卉',
    descriptionHtml: '',
    coverMediaId: 'media-1',
    instructorName: '王老師',
    instructorBioHtml: '',
    level: 'beginner',
    language: 'zh-Hant',
    audienceHtml: '',
    outcomesHtml: '',
    prerequisitesHtml: '',
    materialsHtml: '',
    publishedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

export function anInventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'kit-1',
    sku: 'KIT-1',
    title: '水彩材料包',
    stock: 12,
    enabled: true,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}
