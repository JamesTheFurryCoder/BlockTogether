import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'

// One listener per engine, even when a game spawns many entities.
const controllers = new WeakMap()
// Resolve noa collision IDs back to Entity instances, separately for each engine.
const instances = new WeakMap()

/**
 * A model, physics body, and movement controller backed by noa's ECS.
 * Positions are global [x, y, z] coordinates at the bottom center of the body.
 * The collider is always an upright box, even if the model is rotated.
 *
 * @example
 * import Entity from '../entity.js'
 * const enemy = new Entity(noa, { position: [5, 2, 5], movement: { maxSpeed: 3 } })
 * enemy.rigMovement(self => self.moveToward(noa.playerEntity, 1.5))
 * const unsubscribe = enemy.onCollision(otherId => console.log('Hit', otherId))
 * // enemy.destroy() removes the model, physics body, and controller.
 */
export class Entity {
  /**
   * @param {import('noa-engine').Engine} noa
   * @param {object} [options]
   * @param {string} [options.entityName] Entity and Babylon mesh name. Defaults to the mesh name.
   * @param {number[]} [options.position=[0,2,0]] Bottom-center position.
   * @param {number} [options.width=1] Collider size on both X and Z.
   * @param {number} [options.height=1] Collider height.
   * @param {object|function} [options.model] Unique Babylon mesh, or synchronous
   * factory receiving { noa, scene, width, height }. Defaults to a box.
   * Meshes should be centered at their origin; use meshOffset for other pivots.
   * noa owns and disposes this mesh, including its children. Clone shared models.
   * Custom materials/textures remain the caller's responsibility.
   * @param {number[]} [options.meshOffset] Defaults to [0, height / 2, 0].
   * @param {number[]} [options.color=[0.8,0.3,0.25]] Default box RGB color.
   * @param {boolean} [options.physics=true] Terrain collision and gravity.
   * @param {object} [options.movement] noa movement settings, e.g. maxSpeed,
   * moveForce, jumpImpulse, airMoveMult, standingFriction, responsiveness.
   * @param {number} [options.mass=1]
   * @param {number} [options.gravityMultiplier=1] Set to 0 for flying bodies.
   * @param {boolean} [options.autoStep=false]
   * @param {number} [options.restitution=0] Physics bounciness.
   * @param {number} [options.collideBits=1] Entity collision category bits.
   * @param {number} [options.collideMask=1] Entity categories to notify about.
   */
  constructor(noa, {
    position = [0, 2, 0], width = 1, height = 1, model, entityName,
    meshOffset = [0, height / 2, 0], color = [0.8, 0.3, 0.25],
    physics = true, movement = {}, mass = 1, gravityMultiplier = 1,
    autoStep = false, restitution = 0, collideBits = 1, collideMask = 1,
  } = {}) {
    vector(position, 'position')
    vector(meshOffset, 'meshOffset')
    vector(color, 'color')
    positive(width, 'width')
    positive(height, 'height')
    positive(mass, 'mass')
    if (entityName !== undefined) validateName(entityName)

    this.noa = noa
    this.destroyed = false
    this._collisionHandlers = new Set()
    this._terrainHandlers = new Set()
    this._controller = null
    this._material = null

    const scene = noa.rendering.getScene()
    this.mesh = typeof model === 'function' ? model({ noa, scene, width, height }) : model
    if (model === undefined) {
      this.mesh = CreateBox('entity-box', { width, height, depth: width }, scene)
      this._material = noa.rendering.makeStandardMaterial('entity-box-material')
      this._material.diffuseColor.copyFromFloats(...color)
      this.mesh.material = this._material
    }
    if (!this.mesh || typeof this.mesh.dispose !== 'function' || !this.mesh.position) {
      throw new TypeError('model must be a Babylon mesh or a factory returning one synchronously.')
    }
    if (entityName !== undefined) this.entityName = entityName

    this.id = noa.entities.add([...position], width, height, this.mesh, [...meshOffset], physics)
    const names = noa.entities.names
    if (physics) {
      Object.assign(this.body, { mass, gravityMultiplier, autoStep, restitution })
      noa.entities.addComponent(this.id, names.movement, { ...movement })
      noa.entities.addComponent(this.id, names.collideTerrain, {
        callback: impulse => {
          for (const handler of [...this._terrainHandlers]) {
            if (this.destroyed) break
            handler([...impulse], this)
          }
        },
      })
    }
    noa.entities.addComponent(this.id, names.collideEntities, {
      collideBits, collideMask,
      callback: otherId => {
        for (const handler of [...this._collisionHandlers]) {
          if (this.destroyed) break
          handler(otherId, this)
        }
      },
    })
    if (!instances.has(noa)) instances.set(noa, new Map())
    instances.get(noa).set(this.id, this)
  }

  /** Resolve an onCollision ID; raw noa entities return undefined. */
  static fromId(noa, id) {
    return instances.get(noa)?.get(id)
  }

  /** Shares Babylon's mesh name; assigning here also renames the mesh. */
  get entityName() {
    return this.mesh.name
  }

  set entityName(name) {
    this._assertAlive()
    validateName(name)
    this.mesh.name = name
  }

  /** A copy: use setPosition() to move instead of editing this array. */
  get position() {
    this._assertAlive()
    return [...this.noa.entities.getPosition(this.id)]
  }

  /** The underlying noa rigid body (null when physics is disabled). */
  get body() {
    this._assertAlive()
    return this.noa.entities.getPhysicsBody(this.id)
  }

  /** noa's movement component, available for further tuning. */
  get movement() {
    this._assertAlive()
    return this.noa.entities.getMovement(this.id)
  }

  get grounded() {
    return (this.body?.atRestY() ?? 0) < 0
  }

  /** Teleport. Terrain is not swept; velocity is reset unless requested. */
  setPosition(position, keepVelocity = false) {
    this._assertAlive()
    vector(position, 'position')
    this.noa.entities.setPosition(this.id, [...position])
    if (this.body) {
      if (!keepVelocity) this.body.velocity.fill(0)
      this.body.applyImpulse([0, 0, 0]) // Wake a sleeping physics body.
    }
    return this
  }

  /** Configure noa movement, including maxSpeed, moveForce, and jumpImpulse. */
  setMovement(options) {
    Object.assign(this._requireMovement(), options)
    return this
  }

  /** Run persistently along a world-space X/Z direction until stop() is called. */
  move(x, z, speed = this._requireMovement().maxSpeed) {
    finite(x, 'x')
    finite(z, 'z')
    nonnegative(speed, 'speed')
    const movement = this._requireMovement()
    movement.heading = Math.atan2(x, z)
    movement.maxSpeed = speed
    movement.running = (x !== 0 || z !== 0) && speed > 0
    return this
  }

  // important method for movement
  /** Steer toward an Entity, noa entity ID, or position. Call each tick to follow.
   * Uses horizontal distance; it does not perform pathfinding or avoid obstacles.
   */
  moveToward(target, stopDistance = 0.1, speed = this._requireMovement().maxSpeed) {
    nonnegative(stopDistance, 'stopDistance')
    const [x, , z] = this._targetPosition(target)
    const [px, , pz] = this.position
    return Math.hypot(x - px, z - pz) <= stopDistance
      ? this.stop() : this.move(x - px, z - pz, speed)
  }

  // important method for movement
  /** Stop movement input and horizontal velocity; preserve falling/jumping. */
  stop() {
    const movement = this._requireMovement()
    movement.running = false
    movement.jumping = false
    this.body.velocity[0] = 0
    this.body.velocity[2] = 0
    return this
  }

  // important method for movement
  /** One jump impulse, only while grounded. Returns whether a jump was applied. */
  jump(impulse = this._requireMovement().jumpImpulse) {
    nonnegative(impulse, 'impulse')
    if (!this.grounded) return false
    this.body.applyImpulse([0, impulse, 0])
    return true
  }

  /** Velocity is in world units per second. Useful for projectiles/flying bodies. */
  setVelocity(velocity) {
    vector(velocity, 'velocity')
    const body = this._requireBody()
    body.velocity[0] = velocity[0]
    body.velocity[1] = velocity[1]
    body.velocity[2] = velocity[2]
    body.applyImpulse([0, 0, 0])
    return this
  }

  applyImpulse(impulse) {
    vector(impulse, 'impulse')
    this._requireBody().applyImpulse([...impulse])
    return this
  }

  /** Apply force each tick for sustained acceleration. */
  applyForce(force) {
    vector(force, 'force')
    this._requireBody().applyForce([...force])
    return this
  }

  /** Replace the movement controller. Called on noa ticks as (self, dtSeconds).
   * Noa emits tick after its systems; commands affect subsequent physics ticks.
   */
  rigMovement(controller) {
    this._assertAlive()
    if (typeof controller !== 'function') throw new TypeError('controller must be a function.')
    this._controller = controller
    let group = controllers.get(this.noa)
    if (!group) {
      group = { entities: new Set(), listener: null }
      group.listener = dt => {
        for (const entity of [...group.entities]) {
          if (!entity.destroyed) entity._controller?.(entity, dt / 1000)
        }
      }
      controllers.set(this.noa, group)
      this.noa.on('tick', group.listener)
    }
    group.entities.add(this)
    return this
  }

  /** Detach a controller and stop horizontal movement. */
  unrigMovement() {
    this._assertAlive()
    this._detachController()
    if (this.movement) this.stop()
    return this
  }

  /** Rotate the visual model toward a target on X/Z. Assumes it faces +Z. */
  lookAt(target) {
    const [x, , z] = this._targetPosition(target)
    const [px, , pz] = this.position
    this.mesh.rotationQuaternion = null
    this.mesh.rotation.y = Math.atan2(x - px, z - pz)
    return this
  }

  distanceTo(target) {
    const other = this._targetPosition(target)
    return Math.hypot(...this.position.map((value, axis) => value - other[axis]))
  }

  setVisible(visible) {
    this._assertAlive()
    this.noa.rendering.setMeshVisibility(this.mesh, Boolean(visible))
    return this
  }

  /** Global axis-aligned bounds; a hypothetical position can also be checked. */
  getBounds(position = this.position) {
    this._assertAlive()
    vector(position, 'position')
    const { width, height } = this.noa.entities.getPositionData(this.id)
    return {
      base: [position[0] - width / 2, position[1], position[2] - width / 2],
      max: [position[0] + width / 2, position[1] + height, position[2] + width / 2],
    }
  }

  /** Geometric AABB overlap, independent of collision masks. Includes touching. */
  collidesWith(target) {
    this._assertAlive()
    if (target instanceof Entity && (target.destroyed || target.noa !== this.noa)) return false
    const id = target instanceof Entity ? target.id : target
    if (id === this.id || !this.noa.entities.hasPosition(id)) return false
    return this.noa.entities.getEntitiesInAABB(this.getBounds()).includes(id)
  }

  /** IDs of all overlapping noa entities, including entities outside this class. */
  getCollisions() {
    return this.noa.entities.getEntitiesInAABB(this.getBounds()).filter(id => id !== this.id)
  }

  /** Test loaded solid voxels at this/hypothetical position. Face contact is allowed.
   * Unloaded chunks are reported as air by noa. This is not a swept movement test.
   */
  collidesWithTerrain(position = this.position) {
    const { base, max } = this.getBounds(position)
    const epsilon = 1e-7
    for (let x = Math.floor(base[0] + epsilon); x <= Math.floor(max[0] - epsilon); x++) {
      for (let y = Math.floor(base[1] + epsilon); y <= Math.floor(max[1] - epsilon); y++) {
        for (let z = Math.floor(base[2] + epsilon); z <= Math.floor(max[2] - epsilon); z++) {
          if (this.noa.registry.getBlockSolidity(this.noa.getBlock(x, y, z))) return true
        }
      }
    }
    return false
  }

  /** Subscribe to overlaps each tick. callback(otherId, self); returns unsubscribe.
   * Both entities must have noa's collideEntities component. Masks are respected.
   * These notifications do not push entities apart or block their movement.
   */
  onCollision(callback) {
    return this._subscribe(this._collisionHandlers, callback)
  }

  /** Subscribe to terrain impacts, not continuous resting contact.
   * callback(impulseVector, self); returns unsubscribe. Requires physics.
   */
  onTerrainCollision(callback) {
    this._requireBody()
    return this._subscribe(this._terrainHandlers, callback)
  }

  /** Idempotent. Prefer this over deleting the underlying noa entity directly. */
  destroy() {
    if (this.destroyed) return
    this._detachController()
    this._collisionHandlers.clear()
    this._terrainHandlers.clear()
    instances.get(this.noa)?.delete(this.id)
    this.noa.entities.deleteEntity(this.id) // noa disposes the mesh and body.
    this._material?.dispose() // Only the default material is owned here.
    this.destroyed = true
  }

  _detachController() {
    const group = controllers.get(this.noa)
    if (group) {
      group.entities.delete(this)
      if (group.entities.size === 0) {
        this.noa.removeListener('tick', group.listener)
        controllers.delete(this.noa)
      }
    }
    this._controller = null
  }

  _subscribe(handlers, callback) {
    this._assertAlive()
    if (typeof callback !== 'function') throw new TypeError('callback must be a function.')
    handlers.add(callback)
    return () => handlers.delete(callback)
  }

  _targetPosition(target) {
    this._assertAlive()
    if (target instanceof Entity) {
      if (target.noa !== this.noa) throw new Error('Target belongs to a different noa engine.')
      return target.position
    }
    const position = typeof target === 'number' ? this.noa.entities.getPosition(target) : target
    vector(position, 'target position')
    return position
  }

  _requireBody() {
    const body = this.body
    if (!body) throw new Error('This operation requires an Entity with physics enabled.')
    return body
  }

  _requireMovement() {
    const movement = this.movement
    if (!movement) throw new Error('Movement requires an Entity with physics enabled.')
    return movement
  }

  _assertAlive() {
    if (this.destroyed) throw new Error('Entity has been destroyed.')
  }
}

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`)
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('entityName must be a nonempty string.')
  }
}

function nonnegative(value, name) {
  finite(value, name)
  if (value < 0) throw new RangeError(`${name} must be nonnegative.`)
}

function positive(value, name) {
  finite(value, name)
  if (value <= 0) throw new RangeError(`${name} must be greater than zero.`)
}

function vector(value, name) {
  if (!value || value.length !== 3 || !Array.from(value).every(Number.isFinite)) {
    throw new TypeError(`${name} must contain three finite numbers.`)
  }
}

export default Entity
