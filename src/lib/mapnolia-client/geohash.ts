import type { BBox } from './types'

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

/**
 * Converts a longitude/latitude pair to a world geohash string at the given precision.
 * Each precision level divides the world into 32^precision cells.
 */
export function lonLatToWorldGeohash(precision: number, lon: number, lat: number): string {
  let minLon = -180
  let maxLon = 180
  let minLat = -90
  let maxLat = 90

  let hash = ''
  let bit = 0
  let ch = 0
  let isEven = true

  while (hash.length < precision) {
    if (isEven) {
      const mid = (minLon + maxLon) / 2
      if (lon >= mid) {
        ch |= 1 << (4 - bit)
        minLon = mid
      } else {
        maxLon = mid
      }
    } else {
      const mid = (minLat + maxLat) / 2
      if (lat >= mid) {
        ch |= 1 << (4 - bit)
        minLat = mid
      } else {
        maxLat = mid
      }
    }

    isEven = !isEven
    bit++

    if (bit === 5) {
      hash += BASE32[ch]
      bit = 0
      ch = 0
    }
  }

  return hash
}

/**
 * Decodes a geohash string back to a bounding box.
 */
export function geohashToBBox(geohash: string): BBox {
  let minLon = -180
  let maxLon = 180
  let minLat = -90
  let maxLat = 90
  let isEven = true

  for (const char of geohash.toLowerCase()) {
    const idx = BASE32.indexOf(char)
    if (idx === -1) continue

    for (let bit = 4; bit >= 0; bit--) {
      const bitVal = (idx >> bit) & 1

      if (isEven) {
        const mid = (minLon + maxLon) / 2
        if (bitVal === 1) {
          minLon = mid
        } else {
          maxLon = mid
        }
      } else {
        const mid = (minLat + maxLat) / 2
        if (bitVal === 1) {
          minLat = mid
        } else {
          maxLat = mid
        }
      }

      isEven = !isEven
    }
  }

  return [minLon, minLat, maxLon, maxLat]
}

/**
 * Gets the center point of a geohash cell.
 */
export function geohashCenter(geohash: string): [number, number] {
  const [west, south, east, north] = geohashToBBox(geohash)
  return [(west + east) / 2, (south + north) / 2]
}

/**
 * Calculates the center lon/lat of a tile at given z/x/y coordinates.
 */
export function tileCenterLonLat(z: number, x: number, y: number): { lon: number; lat: number } {
  const n = 2 ** z
  const lon = ((x + 0.5) / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)))
  const lat = (latRad * 180) / Math.PI
  return { lon, lat }
}
