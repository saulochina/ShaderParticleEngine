/* jshint undef: true, unused: true, strict: true */
/* globals SPE */

/**
 * An SPE.Group instance.
 * @typedef {Object} Group
 * @see SPE.Group
 */

/**
 * A map of options to configure an SPE.Group instance.
 * @typedef {Object} GroupOptions
 *
 * @property {Object} texture An object describing the texture used by the group.
 *
 * @property {Object} texture.value An instance of THREE.Texture.
 *
 * @property {Object=} texture.frames A THREE.Vector2 instance describing the number
 *                                    of frames on the x- and y-axis of the given texture.
 *                                    If not provided, the texture will NOT be treated as
 *                                    a sprite-sheet and as such will NOT be animated.
 *
 * @property {Number} [texture.frameCount=texture.frames.x * texture.frames.y] The total number of frames in the sprite-sheet.
 *                                                                   Allows for sprite-sheets that don't fill the entire
 *                                                                   texture.
 *
 * @property {Number} texture.loop The number of loops through the sprite-sheet that should
 *                                 be performed over the course of a single particle's lifetime.
 *
 * @property {Number} fixedTimeStep If no `dt` (or `deltaTime`) value is passed to this group's
 *                                  `tick()` function, this number will be used to move the particle
 *                                  simulation forward. Value in SECONDS.
 *
 * @property {Boolean} hasPerspective Whether the distance a particle is from the camera should affect
 *                                    the particle's size.
 *
 * @property {Boolean} colorize Whether the particles in this group should be rendered with color, or
 *                              whether the only color of particles will come from the provided texture.
 *
 * @property {Number} blending One of Three.js's blending modes to apply to this group's `ShaderMaterial`.
 *
 * @property {Boolean} transparent Whether these particle's should be rendered with transparency.
 *
 * @property {Boolean} alphaTest Sets the alpha value to be used when running an alpha test on the `texture.value` property.
 *
 * @property {Boolean} depthWrite Whether rendering the group has any effect on the depth buffer.
 *
 * @property {Boolean} depthTest Whether to have depth test enabled when rendering this group.
 *
 * @property {Boolean} fog Whether this group's particles should be affected by their scene's fog.
 *
 * @property {Number} scale The scale factor to apply to this group's particle sizes. Useful for
 *                          setting particle sizes to be relative to renderer size.
 */


/**
 * The SPE.Group class. Creates a new group, containing a material, geometry, and mesh.
 *
 * @constructor
 * @param {GroupOptions} options A map of options to configure the group instance.
 */
SPE.Group = function( options ) {
    'use strict';

    var utils = SPE.utils,
        types = utils.types;

    // Ensure we have a map of options to play with
    options = utils.ensureTypedArg( options, types.OBJECT, {} );
    options.texture = utils.ensureTypedArg( options.texture, types.OBJECT, {} );

    // Assign a UUID to this instance
    this.uuid = THREE.Math.generateUUID();

    // If no `deltaTime` value is passed to the `SPE.Group.tick` function,
    // the value of this property will be used to advance the simulation.
    this.fixedTimeStep = utils.ensureTypedArg( options.fixedTimeStep, types.NUMBER, 0.016 );

    // Set properties used in the uniforms map, starting with the
    // texture stuff.
    this.texture = utils.ensureInstanceOf( options.texture.value, THREE.Texture, null );
    this.textureFrames = utils.ensureInstanceOf( options.texture.frames, THREE.Vector2, new THREE.Vector2( 1, 1 ) );
    this.textureFrameCount = utils.ensureTypedArg( options.texture.frameCount, types.NUMBER, this.textureFrames.x * this.textureFrames.y );
    this.textureLoop = utils.ensureTypedArg( options.texture.loop, types.NUMBER, 1 );
    this.textureFrames.max( new THREE.Vector2( 1, 1 ) );

    this.hasPerspective = utils.ensureTypedArg( options.hasPerspective, types.BOOLEAN, true );
    this.colorize = utils.ensureTypedArg( options.colorize, types.BOOLEAN, true );


    // Set properties used to define the ShaderMaterial's appearance.
    this.blending = utils.ensureTypedArg( options.blending, types.NUMBER, THREE.AdditiveBlending );
    this.transparent = utils.ensureTypedArg( options.transparent, types.BOOLEAN, true );
    this.alphaTest = utils.ensureTypedArg( options.alphaTest, types.NUMBER, 0.5 );
    this.depthWrite = utils.ensureTypedArg( options.depthWrite, types.BOOLEAN, false );
    this.depthTest = utils.ensureTypedArg( options.depthTest, types.BOOLEAN, true );
    this.fog = utils.ensureTypedArg( options.fog, types.BOOLEAN, true );
    this.scale = utils.ensureTypedArg( options.scale, types.NUMBER, 300 );

    // Where emitter's go to curl up in a warm blanket and live
    // out their days.
    this.emitters = [];
    this.emitterIDs = [];

    // Create properties for use by the emitter pooling functions.
    this._pool = [];
    this._poolCreationSettings = null;
    this._createNewWhenPoolEmpty = 0;


    // Map of uniforms to be applied to the ShaderMaterial instance.
    this.uniforms = {
        texture: {
            type: 't',
            value: this.texture
        },
        textureAnimation: {
            type: 'v4',
            value: new THREE.Vector4(
                this.textureFrames.x,
                this.textureFrames.y,
                this.textureFrameCount,
                Math.max( Math.abs( this.textureLoop ), 1.0 )
            )
        },
        fogColor: {
            type: 'c',
            value: null
        },
        fogNear: {
            type: 'f',
            value: 10
        },
        fogFar: {
            type: 'f',
            value: 200
        },
        fogDensity: {
            type: 'f',
            value: 0.5
        },
        deltaTime: {
            type: 'f',
            value: 0
        },
        runTime: {
            type: 'f',
            value: 0
        },
        scale: {
            type: 'f',
            value: this.scale
        }
    };

    // Add some defines into the mix...
    this.defines = {
        HAS_PERSPECTIVE: this.hasPerspective,
        COLORIZE: this.colorize,
        VALUE_OVER_LIFETIME_LENGTH: SPE.valueOverLifetimeLength,

        SHOULD_ROTATE_TEXTURE: false,
        SHOULD_ROTATE_PARTICLES: false,
        SHOULD_WIGGLE_PARTICLES: false,

        SHOULD_CALCULATE_SPRITE: this.textureFrames.x > 1 || this.textureFrames.y > 1
    };

    // Map of all attributes to be applied to the particles.
    //
    // See SPE.ShaderAttribute for a bit more info on this bit.
    this.attributes = {
        position: new SPE.ShaderAttribute( 'v3', true ),
        acceleration: new SPE.ShaderAttribute( 'v4', true ), // w component is drag
        velocity: new SPE.ShaderAttribute( 'v3', true ),
        rotation: new SPE.ShaderAttribute( 'v4', true ),
        rotationCenter: new SPE.ShaderAttribute( 'v3', true ),
        params: new SPE.ShaderAttribute( 'v4', true ), // Holds (alive, age, delay, wiggle)
        size: new SPE.ShaderAttribute( 'v4', true ),
        angle: new SPE.ShaderAttribute( 'v4', true ),
        color: new SPE.ShaderAttribute( 'v4' ),
        opacity: new SPE.ShaderAttribute( 'v4', true )
    };

    this.attributeKeys = Object.keys( this.attributes );
    this.attributeCount = this.attributeKeys.length;

    // Create the ShaderMaterial instance that'll help render the
    // particles.
    this.material = new THREE.ShaderMaterial( {
        uniforms: this.uniforms,
        vertexShader: SPE.shaders.vertex,
        fragmentShader: SPE.shaders.fragment,
        blending: this.blending,
        transparent: this.transparent,
        alphaTest: this.alphaTest,
        depthWrite: this.depthWrite,
        depthTest: this.depthTest,
        defines: this.defines,
        fog: this.fog
    } );

    // Create the BufferGeometry and Points instances, ensuring
    // the geometry and material are given to the latter.
    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.Points( this.geometry, this.material );
};

SPE.Group.constructor = SPE.Group;


SPE.Group.prototype._updateDefines = function( emitter ) {
    'use strict';

    // Only do angle calculation if there's no spritesheet defined.
    //
    // Saves calculations being done and then overwritten in the shaders.
    if ( !this.defines.SHOULD_CALCULATE_SPRITE ) {
        this.defines.SHOULD_ROTATE_TEXTURE = this.defines.SHOULD_ROTATE_TEXTURE || !!Math.max(
            Math.max.apply( null, emitter.angle.value ),
            Math.max.apply( null, emitter.angle.spread )
        );
    }

    this.defines.SHOULD_ROTATE_PARTICLES = this.defines.SHOULD_ROTATE_PARTICLES || !!Math.max(
        emitter.rotation.angle,
        emitter.rotation.angleSpread
    );

    this.defines.SHOULD_WIGGLE_PARTICLES = this.defines.SHOULD_WIGGLE_PARTICLES || !!Math.max(
        emitter.wiggle.value,
        emitter.wiggle.spread
    );
};

SPE.Group.prototype._applyAttributesToGeometry = function() {
    'use strict';

    var attributes = this.attributes,
        geometry = this.geometry,
        geometryAttributes = geometry.attributes,
        attribute,
        geometryAttribute;

    for ( var attr in attributes ) {
        attribute = attributes[ attr ];

        // Update the array if this attribute exists on the geometry.
        //
        // This needs to be done because the attribute's typed array might have
        // been resized and reinstantiated, and might now be looking at a
        // different ArrayBuffer, so reference needs updating.
        if ( geometryAttribute = geometryAttributes[ attr ] ) {
            geometryAttribute.array = attribute.typedArray.array;
        }

        // Add the attribute to the geometry if it doesn't already exist.
        else {
            geometry.addAttribute( attr, attribute.bufferAttribute );
        }

        attribute.bufferAttribute.needsUpdate = true;
    }
};

/**
 * Adds an SPE.Emitter instance to this group, creating particle values and
 * assigning them to this group's shader attributes.
 *
 * @param {Emitter} emitter The emitter to add to this group.
 */
SPE.Group.prototype.addEmitter = function( emitter ) {
    'use strict';

    // Ensure an actual emitter instance is passed here.
    //
    // Decided not to throw here, just in case a scene's
    // rendering would be paused. Logging an error instead
    // of stopping execution if exceptions aren't caught.
    if ( emitter instanceof SPE.Emitter === false ) {
        console.error( '`emitter` argument must be instance of SPE.Emitter. Was provided with:', emitter );
        return;
    }
    else if ( this.emitterIDs.indexOf( emitter.uuid ) > -1 ) {
        console.warn( 'Emitter already exists in this group. Will not add again.' );
        return;
    }
    else if ( emitter.group !== null ) {
        console.error( 'Emitter already belongs to another group. Will not add to requested group.' );
        return;
    }

    console.time( 'SPE.Group.prototype.addEmitter' );


    var attributes = this.attributes,
        start = attributes.position.getLength() / 3,
        totalParticleCount = start + emitter.particleCount;

    // Set the `particlesPerSecond` value (PPS) on the emitter.
    // It's used to determine how many particles to release
    // on a per-frame basis.
    emitter._calculatePPSValue( emitter.maxAge._value + emitter.maxAge._spread );
    emitter._setBufferUpdateRanges( this.attributeKeys );

    // Store the offset value in the TypedArray attributes for this emitter.
    emitter.attributeOffset = start;
    emitter.activationIndex = start;

    // Save a reference to this group on the emitter so it knows
    // where it belongs.
    emitter.group = this;

    // Store reference to the attributes on the emitter for
    // easier access during the emitter's tick function.
    emitter.attributes = this.attributes;



    // Ensure the attributes and their BufferAttributes exist, and their
    // TypedArrays are of the correct size.
    for ( var attr in attributes ) {
        attributes[ attr ]._createBufferAttribute( totalParticleCount );
    }



    // Loop through each particle this emitter wants to have, and create the attributes values,
    // storing them in the TypedArrays that each attribute holds.
    //
    // TODO: Optimise this!
    for ( var i = start, relativeIndex, particleStartTime; i < totalParticleCount; ++i ) {
        relativeIndex = i - start;
        particleStartTime = relativeIndex / emitter.particlesPerSecond;

        emitter._assignPositionValue( i );
        emitter._assignForceValue( i, 'velocity' );
        emitter._assignForceValue( i, 'acceleration' );
        emitter._assignLifetimeValue( i, 'opacity' );
        emitter._assignLifetimeValue( i, 'size' );
        emitter._assignAngleValue( i );
        emitter._assignRotationValue( i );
        emitter._assignParamsValue( i );
        emitter._assignColorValue( i );

        // alive, age, maxAge, wiggle
        // attributes.params.typedArray.setVec4Components( i,
        //     emitter.isStatic ? 1 : 0,
        //     0,
        //     Math.abs( utils.randomFloat( emitter.maxAge._value, emitter.maxAge._spread ) ),
        //     utils.randomFloat( emitter.wiggle._value, emitter.wiggle._spread )
        // );

    }

    // Update the geometry and make sure the attributes are referencing
    // the typed arrays properly.
    this._applyAttributesToGeometry();

    // Store this emitter in this group's emitter's store.
    this.emitters.push( emitter );
    this.emitterIDs.push( emitter.uuid );

    // Update certain flags to enable shader calculations only if they're necessary.
    this._updateDefines( emitter );

    // Update the material since defines might have changed
    this.material.needsUpdate = true;

    console.timeEnd( 'SPE.Group.prototype.addEmitter' );

    return this;
};

/**
 * Removes an SPE.Emitter instance from this group. When called,
 * all particle's belonging to the given emitter will be instantly
 * removed from the scene.
 *
 * @param {Emitter} emitter The emitter to add to this group.
 */
SPE.Group.prototype.removeEmitter = function( emitter ) {
    'use strict';

    var emitterIndex = this.emitterIDs.indexOf( emitter.uuid );

    // Ensure an actual emitter instance is passed here.
    //
    // Decided not to throw here, just in case a scene's
    // rendering would be paused. Logging an error instead
    // of stopping execution if exceptions aren't caught.
    if ( emitter instanceof SPE.Emitter === false ) {
        console.error( '`emitter` argument must be instance of SPE.Emitter. Was provided with:', emitter );
        return;
    }
    else if ( emitterIndex === -1 ) {
        console.warn( 'Emitter does not exist in this group. Will not remove.' );
        return;
    }

    // Kill all particles.
    var start = emitter.attributeOffset,
        end = start + emitter.particleCount,
        params = this.attributes.params.typedArray;

    for ( var i = start; i < end; ++i ) {
        params.array[ i * 4 ] = 0.0;
        params.array[ i * 4 + 1 ] = 0.0;
    }

    this.emitters.splice( emitterIndex, 1 );
    this.emitterIDs.splice( emitterIndex, 1 );

    // Remove this emitter's attribute values from all shader attributes.
    // The `.splice()` call here also marks each attribute's buffer
    // as needing to update it's entire contents.
    for ( var attr in this.attributes ) {
        this.attributes[ attr ].splice( start, end );
    }

    // Reset the emitter's group reference.
    emitter.group = null;
};


/**
 * Fetch a single emitter instance from the pool.
 * If there are no objects in the pool, a new emitter will be
 * created if specified.
 *
 * @return {Emitter|null}
 */
SPE.Group.prototype.getFromPool = function() {
    'use strict';

    var that = this,
        pool = that._pool,
        createNew = that._createNewWhenPoolEmpty;

    if ( pool.length ) {
        return pool.pop();
    }
    else if ( createNew ) {
        return new SPE.Emitter( that._poolCreationSettings );
    }

    return null;
};


/**
 * Release an emitter into the pool.
 *
 * @param  {ShaderParticleEmitter} emitter
 * @return {Group} This group instance.
 */
SPE.Group.prototype.releaseIntoPool = function( emitter ) {
    'use strict';

    if ( emitter instanceof SPE.Emitter === false ) {
        console.error( 'Argument is not instanceof SPE.Emitter:', emitter );
        return;
    }

    emitter.reset();
    this._pool.unshift( emitter );

    return this;
};


/**
 * Get the pool array
 *
 * @return {Array}
 */
SPE.Group.prototype.getPool = function() {
    'use strict';

    return this._pool;
};


/**
 * Add a pool of emitters to this particle group
 *
 * @param {Number} numEmitters      The number of emitters to add to the pool.
 * @param {EmitterOptions} emitterOptions  An object describing the options to pass to each emitter.
 * @param {Boolean} createNew       Should a new emitter be created if the pool runs out?
 * @return {Group} This group instance.
 */
SPE.Group.prototype.addPool = function( numEmitters, emitterOptions, createNew ) {
    'use strict';

    var that = this,
        emitter;

    // Save relevant settings and flags.
    that._poolCreationSettings = emitterSettings;
    that._createNewWhenPoolEmpty = !!createNew;

    // Create the emitters, add them to this group and the pool.
    for ( var i = 0; i < numEmitters; ++i ) {
        emitter = new SPE.Emitter( emitterSettings );
        that.addEmitter( emitter );
        that.releaseIntoPool( emitter );
    }

    return that;
};



SPE.Group.prototype._triggerSingleEmitter = function( pos ) {
    'use strict';

    var that = this,
        emitter = that.getFromPool();

    if ( emitter === null ) {
        console.log( 'SPE.Group pool ran out.' );
        return;
    }

    // TODO:
    // - Make sure buffers are update with thus new position.
    if ( pos instanceof THREE.Vector3 ) {
        emitter.position.value.copy( pos );
        emitter.position.value = emitter.position.value; // Trigger the setter.
    }

    emitter.enable();

    setTimeout( function() {
        emitter.disable();
        that.releaseIntoPool( emitter );
    }, emitter.maxAge.value + emitter.maxAge.spread );

    return that;
};


/**
 * Set a given number of emitters as alive, with an optional position
 * vector3 to move them to.
 *
 * @param  {Number} numEmitters The number of emitters to activate
 * @param  {Object} [position=undefined] A THREE.Vector3 instance describing the position to activate the emitter(s) at.
 * @return {Group} This group instance.
 */
SPE.Group.prototype.triggerPoolEmitter = function( numEmitters, position ) {
    'use strict';

    var that = this;

    if ( typeof numEmitters === 'number' && numEmitters > 1 ) {
        for ( var i = 0; i < numEmitters; ++i ) {
            that._triggerSingleEmitter( position );
        }
    }
    else {
        that._triggerSingleEmitter( position );
    }

    return that;
};



SPE.Group.prototype._updateUniforms = function( dt ) {
    'use strict';

    this.uniforms.runTime.value += dt;
    this.uniforms.deltaTime.value = dt;
};

SPE.Group.prototype._resetBufferRanges = function() {
    'use strict';

    var keys = this.attributeKeys,
        i = this.attributeCount - 1,
        attrs = this.attributes;

    for ( i; i >= 0; --i ) {
        attrs[ keys[ i ] ].resetUpdateRange();
    }
};


SPE.Group.prototype._updateBuffers = function( emitter ) {
    'use strict';

    var keys = this.attributeKeys,
        i = this.attributeCount - 1,
        attrs = this.attributes,
        emitterRanges = emitter.bufferUpdateRanges,
        key,
        emitterAttr,
        attr;

    for ( i; i >= 0; --i ) {
        key = keys[ i ];
        emitterAttr = emitterRanges[ key ];
        attr = attrs[ key ];
        attr.setUpdateRange( emitterAttr.min, emitterAttr.max );
        attr.flagUpdate();
    }
};


/**
 * Simulate all the emitter's belonging to this group, updating
 * attribute values along the way.
 * @param  {Number} [dt=Group's `fixedTimeStep` value] The number of seconds to simulate the group's emitters for (deltaTime)
 */
SPE.Group.prototype.tick = function( dt ) {
    'use strict';

    var emitters = this.emitters,
        numEmitters = emitters.length,
        deltaTime = dt || this.fixedTimeStep;

    if ( numEmitters === 0 ) {
        return;
    }

    this._updateUniforms( deltaTime );
    this._resetBufferRanges();

    for ( var i = 0, emitter; i < numEmitters; ++i ) {
        emitter = emitters[ i ];
        emitter.tick( deltaTime );
        this._updateBuffers( emitter );
    }
};