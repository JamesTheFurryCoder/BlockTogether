import { Entity } from './entity.js'

export class enemy extends Entity {
  #health

  /** Accepts Entity's options plus health, which defaults to 100. */
  constructor(noa, { health = 100, ...options } = {}) {
    validateHealth(health)
    super(noa, options)
    this.#health = health
  }

  get health() {
    return this.#health
  }

  set health(value) {
    //validateHealth(value)
    this.#health = value
  }
}

function validateHealth(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('health must be a finite, nonnegative number.')
  }
}

export default enemy
