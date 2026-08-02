/**
 * Shapes for tests, built once.
 *
 * A test that spells out every field of a Course is a test that has to be
 * edited whenever one is added — and the edit is never interesting, so it
 * gets done carelessly. These take the fields a test actually cares about
 * and fill in the rest.
 */

import type { Course, InventoryItem, PublicProductDetail, PublicVariant, VideoAsset } from '../types'

export function aCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: 'course-1',
    slug: 'watercolour',
    title: '水彩花卉入門',
    status: 'published',
    summary: '兩小時學會水彩花卉',
    descriptionHtml: '',
    coverMediaId: 'media-1',
    coverPath: '/media-assets/abc123.webp',
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

export function aVideoAsset(overrides: Partial<VideoAsset> = {}): VideoAsset {
  return {
    id: 'asset-1',
    title: '第一課：工具介紹',
    originalFilename: 'lesson-01.mp4',
    status: 'ready',
    byteSize: 1_500_000_000,
    durationSeconds: 754,
    width: 1920,
    height: 1080,
    encodeVersion: 1,
    hasPoster: true,
    errorCode: null,
    errorDetail: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  }
}

export function aPublicProduct(overrides: Partial<PublicProductDetail> = {}): PublicProductDetail {
  return {
    slug: 'soda-tote',
    title: '蘇打托特包',
    description: '',
    images: [],
    requiresOfferSelection: false,
    variants: [],
    categories: [],
    courses: [],
    containsCourse: false,
    ...overrides,
  }
}

export function aPublicVariant(overrides: Partial<PublicVariant> = {}): PublicVariant {
  return { id: 'v1', title: null, price: 350, inStock: true, stockLeft: null, ...overrides }
}
