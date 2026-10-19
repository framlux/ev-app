import { describe, expect, it } from 'vitest'
import {
  MAX_GROUP_SIZE,
  RIVIAN_PROPERTIES,
  SHAPE_SELECTIONS,
  chargingSessionDocument,
  cloudConnectionDocument,
  departureSchedulesDocument,
  geofencesDocument,
  groupProperties,
  otaInstallSchedulesDocument,
  otaInstallStateDocument,
  parallaxDocument,
  shapeOf,
  vehicleStateDocument,
  type SubscriptionDocument,
} from '../src/catalogue.js'

describe('RIVIAN_PROPERTIES', () => {
  it('lists each property once', () => {
    const names = RIVIAN_PROPERTIES.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names every property in camelCase, which is how the API spells a field', () => {
    for (const { name } of RIVIAN_PROPERTIES) {
      expect(name, name).toMatch(/^[a-z][a-zA-Z0-9]*$/)
    }
  })

  it('holds the 135 names the first release subscribes to', () => {
    // A count to be changed on purpose, with the list: a bad paste that drops a
    // block of names fails here rather than silently narrowing the subscription.
    expect(RIVIAN_PROPERTIES).toHaveLength(135)
  })

  it('lists them in alphabetical order, by UTF-16 code unit', () => {
    // The comment on the list says so, and groups are cut from this order, so a
    // hand-edit that drops a name in the wrong place moves its neighbours.
    const names = RIVIAN_PROPERTIES.map((p) => p.name)
    expect(names).toEqual([...names].sort())
    // Code-unit order, not locale order: an upper-case letter sorts first.
    expect(names.indexOf('chargingDisabledACFaultState')).toBeLessThan(
      names.indexOf('chargingDisabledAll'),
    )
  })

  it('gives exactly three properties a structured shape', () => {
    const structured = RIVIAN_PROPERTIES.filter((p) => p.shape !== 'value')
    expect(structured.map((p) => [p.name, p.shape])).toEqual([
      ['cloudConnection', 'cloudConnection'],
      ['gnssError', 'locationError'],
      ['gnssLocation', 'location'],
    ])
  })

  it('gives every other property the plain { timeStamp value } shape', () => {
    for (const p of RIVIAN_PROPERTIES) {
      if (!['cloudConnection', 'gnssLocation', 'gnssError'].includes(p.name)) {
        expect(p.shape, p.name).toBe('value')
      }
    }
  })

  it('keeps geoLocation, which is not gnssLocation, as a plain value', () => {
    expect(shapeOf('geoLocation')).toBe('value')
  })

  it('includes the properties the later tasks decode by name', () => {
    const names = new Set(RIVIAN_PROPERTIES.map((p) => p.name))
    for (const name of [
      'batteryLevel', 'batteryCapacity', 'distanceToEmpty', 'vehicleMileage', 'gnssSpeed',
      'gearStatus', 'powerState', 'chargerState', 'chargerStatus', 'timeToEndOfCharge',
      'tirePressureFrontLeft', 'activeDriverName', 'chargingDisabledACFaultState',
    ]) {
      expect(names.has(name), name).toBe(true)
    }
  })
})

describe('shapeOf', () => {
  it('returns the catalogue shape of a known property', () => {
    expect(shapeOf('gnssLocation')).toBe('location')
    expect(shapeOf('cloudConnection')).toBe('cloudConnection')
    expect(shapeOf('gnssError')).toBe('locationError')
    expect(shapeOf('batteryLevel')).toBe('value')
  })

  it('treats a property it has never heard of as a plain value', () => {
    // Discovery adds only fields typed TimeStamped*, which are { timeStamp value }.
    expect(shapeOf('someFutureR2Property')).toBe('value')
  })

  it('is not fooled by a name that is also an Object property', () => {
    expect(shapeOf('constructor')).toBe('value')
    expect(shapeOf('__proto__')).toBe('value')
  })
})

describe('SHAPE_SELECTIONS', () => {
  it('holds the selection each shape is asked for with, one field per line', () => {
    expect(SHAPE_SELECTIONS.value).toBe(`{
  timeStamp
  value
}`)
    expect(SHAPE_SELECTIONS.location).toBe(`{
  timeStamp
  latitude
  longitude
  isAuthorized
}`)
    expect(SHAPE_SELECTIONS.cloudConnection).toBe(`{
  isOnline
  lastSync
}`)
    expect(SHAPE_SELECTIONS.locationError).toBe(`{
  timeStamp
  bearing
  positionHorizontal
  positionVertical
  speed
}`)
  })

  it('has a selection for every shape and no other', () => {
    expect(Object.keys(SHAPE_SELECTIONS).sort()).toEqual(
      ['cloudConnection', 'location', 'locationError', 'value'],
    )
  })
})

describe('groupProperties', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)

  it('splits forty names into groups of 16, 16 and 8, in order', () => {
    const groups = groupProperties(names(40))
    expect(groups.map((g) => g.length)).toEqual([16, 16, 8])
    expect(groups.flat()).toEqual(names(40))
  })

  it('gives no groups for no names', () => {
    expect(groupProperties([])).toEqual([])
  })

  it('keeps exactly sixteen in one group, and splits at seventeen', () => {
    expect(groupProperties(names(16)).map((g) => g.length)).toEqual([16])
    expect(groupProperties(names(17)).map((g) => g.length)).toEqual([16, 1])
    expect(MAX_GROUP_SIZE).toBe(16)
  })

  it('takes a smaller size, which is what bisection asks for', () => {
    expect(groupProperties(names(5), 2)).toEqual([['p0', 'p1'], ['p2', 'p3'], ['p4']])
  })

  it('refuses a size that would loop forever or break the 16-property limit', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 17]) {
      expect(() => groupProperties(names(3), bad), String(bad)).toThrow(RangeError)
    }
  })

  it('does not alter the list it is given', () => {
    const input = names(20)
    groupProperties(input)
    expect(input).toEqual(names(20))
  })

  it('splits the whole catalogue into groups no larger than the limit', () => {
    const groups = groupProperties(RIVIAN_PROPERTIES.map((p) => p.name))
    expect(groups.every((g) => g.length <= MAX_GROUP_SIZE)).toBe(true)
    expect(groups.flat()).toHaveLength(RIVIAN_PROPERTIES.length)
  })
})

describe('vehicleStateDocument', () => {
  it('asks for each property in the shape it has', () => {
    const doc = vehicleStateDocument('veh', ['batteryLevel', 'gnssLocation'])
    expect(doc.operationName).toBe('VehicleState')
    expect(doc.variables).toEqual({ vehicleId: 'veh' })
    expect(doc.query).toBe(`subscription VehicleState($vehicleId: String!) {
  vehicleState(id: $vehicleId) {
    batteryLevel {
      timeStamp
      value
    }
    gnssLocation {
      timeStamp
      latitude
      longitude
      isAuthorized
    }
  }
}`)
  })

  it('selects the structured shapes with their own fields', () => {
    const { query } = vehicleStateDocument('veh', ['cloudConnection', 'gnssError'])
    expect(query).toContain(`    cloudConnection {
      isOnline
      lastSync
    }`)
    expect(query).toContain(`    gnssError {
      timeStamp
      bearing
      positionHorizontal
      positionVertical
      speed
    }`)
  })

  it('selects a property it does not know as a plain value', () => {
    expect(vehicleStateDocument('veh', ['someFutureR2Property']).query).toContain(
      `    someFutureR2Property {
      timeStamp
      value
    }`,
    )
  })

  it('carries the vehicle id as a variable, never inside the query text', () => {
    const doc = vehicleStateDocument('veh" } } injected', ['batteryLevel'])
    expect(doc.query).not.toContain('injected')
    expect(doc.variables).toEqual({ vehicleId: 'veh" } } injected' })
  })

  it('builds a document for a full group of sixteen from the catalogue', () => {
    const [group] = groupProperties(RIVIAN_PROPERTIES.map((p) => p.name))
    const doc = vehicleStateDocument('veh', group!)
    expect(group).toHaveLength(16)
    for (const name of group!) expect(doc.query).toContain(`\n    ${name} {\n`)
  })

  it('keeps the properties in the order it was given', () => {
    const { query } = vehicleStateDocument('veh', ['speedLike', 'aaa', 'mmm'])
    expect(query.indexOf('speedLike')).toBeLessThan(query.indexOf('aaa'))
    expect(query.indexOf('aaa')).toBeLessThan(query.indexOf('mmm'))
  })

  describe('refuses text that is not a property name', () => {
    it('an empty list, which would be an empty selection set', () => {
      expect(() => vehicleStateDocument('veh', [])).toThrow(RangeError)
    })

    it.each([
      ['an empty name', ''],
      ['a name with a space', 'battery level'],
      ['a name that starts with a digit', '1battery'],
      ['a name with a hyphen', 'battery-level'],
      ['a name with a dot', 'battery.level'],
      ['a name that closes the selection', 'x } } subscription Y { z'],
      ['a name with a newline', 'a\nb'],
      ['a name with a trailing newline', 'batteryLevel\n'],
      ['a name with a non-ASCII letter', 'batteryLevél'],
      ['a name with a NUL', 'battery\u0000Level'],
      ['a name with a comment marker', 'a # b'],
      ['a name with a directive', 'a @skip(if: true)'],
    ])('%s', (_label, name) => {
      expect(() => vehicleStateDocument('veh', ['batteryLevel', name])).toThrow(RangeError)
    })

    it('and says where, not what: the offending text is not in the message', () => {
      const bad = 'sneaky } { text'
      let message = ''
      try {
        vehicleStateDocument('veh', ['batteryLevel', 'powerState', bad])
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain('position 2')
      expect(message).not.toContain('sneaky')
      expect(message).not.toContain(bad)
    })

    it('whichever position it is in', () => {
      expect(() => vehicleStateDocument('veh', ['a b', 'powerState'])).toThrow(RangeError)
      expect(() => vehicleStateDocument('veh', ['powerState', 'a b'])).toThrow(RangeError)
    })
  })

  it('accepts what GraphQL calls a name, including a leading underscore and digits after', () => {
    for (const name of ['_x', 'x1', 'X_9', '_', 'batteryLevel']) {
      expect(() => vehicleStateDocument('veh', [name]), name).not.toThrow()
    }
  })

  it('accepts every name in the catalogue', () => {
    expect(() =>
      vehicleStateDocument('veh', RIVIAN_PROPERTIES.map((p) => p.name)),
    ).not.toThrow()
  })
})

describe('parallaxDocument', () => {
  it('asks for every topic when rvms is null', () => {
    const doc = parallaxDocument('veh', null)
    expect(doc.operationName).toBe('ParallaxMessages')
    expect(doc.variables).toEqual({ vehicleId: 'veh', topics: null })
    expect(doc.query).toBe(`subscription ParallaxMessages($vehicleId: String!, $topics: [String!]) {
  parallaxMessages(vehicleId: $vehicleId, rvms: $topics) {
    payload
    timestamp
    rvm
  }
}`)
  })

  it('passes a list of topics through as a variable', () => {
    const rvms = ['energy_management.charging_status', 'vehicle.speed']
    const doc = parallaxDocument('veh', rvms)
    expect(doc.variables).toEqual({ vehicleId: 'veh', topics: rvms })
    expect(doc.variables.topics).not.toBe(rvms)
  })

  it('declares the topic filter as an optional list, so null is legal', () => {
    expect(parallaxDocument('veh', null).query).toContain('$topics: [String!])')
  })
})

describe('chargingSessionDocument', () => {
  // Spec §2.3, written out independently of the implementation.
  const LIVE_DATA = [
    'powerKW', 'kilometersChargedPerHour', 'rangeAddedThisSession', 'totalChargedEnergy',
    'timeElapsed', 'timeRemaining', 'price', 'currency', 'isFreeSession', 'vehicleChargerState',
    'startTime',
  ]
  const CHART_DATA = [
    'soc', 'powerKW', 'startTime', 'endTime', 'timeEstimationValidityStatus', 'vehicleChargerState',
  ]

  const selected = (query: string, block: string): string[] => {
    const match = new RegExp(`${block} \\{([^{}]*)\\}`).exec(query)
    expect(match, `${block} block`).not.toBeNull()
    return match![1]!.trim().split(/\s+/)
  }

  it('selects every liveData and chartData field the spec lists, and no others', () => {
    const doc = chargingSessionDocument('veh')
    expect(doc.operationName).toBe('ChargingSession')
    expect(doc.variables).toEqual({ vehicleId: 'veh' })
    expect(selected(doc.query, 'liveData')).toEqual(LIVE_DATA)
    expect(selected(doc.query, 'chartData')).toEqual(CHART_DATA)
  })

  it('is exactly this document, chartData first as the schema declares it', () => {
    expect(chargingSessionDocument('veh').query).toBe(`subscription ChargingSession($vehicleId: String!) {
  chargingSession(vehicleId: $vehicleId) {
    chartData {
      soc
      powerKW
      startTime
      endTime
      timeEstimationValidityStatus
      vehicleChargerState
    }
    liveData {
      powerKW
      kilometersChargedPerHour
      rangeAddedThisSession
      totalChargedEnergy
      timeElapsed
      timeRemaining
      price
      currency
      isFreeSession
      vehicleChargerState
      startTime
    }
  }
}`)
  })
})

describe('cloudConnectionDocument', () => {
  it('feeds its vehicle variable to the argument this subscription calls id', () => {
    expect(cloudConnectionDocument('veh')).toEqual({
      operationName: 'VehicleCloudConnection',
      query: `subscription VehicleCloudConnection($vehicleId: String!) {
  vehicleCloudConnection(id: $vehicleId) {
    isOnline
    lastSync
  }
}`,
      variables: { vehicleId: 'veh' },
    })
  })
})

describe('the bare-payload subscriptions', () => {
  it('select payload and sequenceNumber from their own field', () => {
    expect(otaInstallStateDocument('veh')).toEqual({
      operationName: 'OtaInstallState',
      query: `subscription OtaInstallState($vehicleId: String!) {
  otaInstallState(vehicleId: $vehicleId) {
    payload
    sequenceNumber
  }
}`,
      variables: { vehicleId: 'veh' },
    })
    expect(otaInstallSchedulesDocument('veh')).toEqual({
      operationName: 'OtaInstallSchedules',
      query: `subscription OtaInstallSchedules($vehicleId: String!) {
  otaInstallSchedules(vehicleId: $vehicleId) {
    payload
    sequenceNumber
  }
}`,
      variables: { vehicleId: 'veh' },
    })
    expect(geofencesDocument('veh')).toEqual({
      operationName: 'VehicleGeofences',
      query: `subscription VehicleGeofences($vehicleId: String!) {
  vehicleGeofences(vehicleId: $vehicleId) {
    payload
    sequenceNumber
  }
}`,
      variables: { vehicleId: 'veh' },
    })
  })

  it('do not ask for the topic fields only parallaxMessages has', () => {
    for (const doc of [
      otaInstallStateDocument('veh'),
      otaInstallSchedulesDocument('veh'),
      geofencesDocument('veh'),
    ]) {
      expect(doc.query, doc.operationName).not.toMatch(/\btimestamp\b|\brvm\b/)
    }
  })
})

describe('departureSchedulesDocument', () => {
  it('selects the full schedule, with the weekly occurrence behind a fragment', () => {
    expect(departureSchedulesDocument('veh')).toEqual({
      operationName: 'VehicleDepartureSchedules',
      query: `subscription VehicleDepartureSchedules($vehicleId: String!) {
  vehicleDepartureSchedules(vehicleId: $vehicleId) {
    id
    name
    isEnabled
    occurrence {
      ... on RepeatsWeekly {
        days
        startsAtMin
        skippedOn
      }
      __typename
    }
    departureSettings {
      shouldOverrideChargeSchedule
      comfortSettings {
        surfaceHeatVentLevels {
          frontLeftSeat
          frontRightSeat
          rearLeftSeat
          rearRightSeat
          steeringWheel
        }
        cabinTempCelsius
        frontDefogDefrost
      }
    }
  }
}`,
      variables: { vehicleId: 'veh' },
    })
  })
})

describe('every document', () => {
  const documents: SubscriptionDocument[] = [
    vehicleStateDocument('veh', ['batteryLevel', 'gnssLocation', 'cloudConnection', 'gnssError']),
    parallaxDocument('veh', null),
    parallaxDocument('veh', ['a']),
    chargingSessionDocument('veh'),
    cloudConnectionDocument('veh'),
    otaInstallStateDocument('veh'),
    otaInstallSchedulesDocument('veh'),
    geofencesDocument('veh'),
    departureSchedulesDocument('veh'),
  ]

  it('is a subscription whose braces balance', () => {
    for (const doc of documents) {
      expect(doc.query, doc.operationName).toMatch(/^subscription \w+\(/)
      const open = doc.query.split('{').length - 1
      const close = doc.query.split('}').length - 1
      expect(open, doc.operationName).toBe(close)
    }
  })

  it('names its operation the same in the header and in operationName', () => {
    for (const doc of documents) {
      expect(doc.query.startsWith(`subscription ${doc.operationName}(`), doc.operationName).toBe(true)
    }
  })

  it('declares exactly the variables it supplies, and uses each one', () => {
    for (const doc of documents) {
      const header = /^subscription \w+\(([^)]*)\)/.exec(doc.query)![1]!
      const declared = [...header.matchAll(/\$(\w+):/g)].map((m) => m[1]!).sort()
      expect(declared, doc.operationName).toEqual(Object.keys(doc.variables).sort())
      const body = doc.query.slice(doc.query.indexOf(')') + 1)
      for (const name of declared) {
        expect(body, `${doc.operationName} $${name}`).toContain(`$${name}`)
      }
    }
  })

  it('spells the vehicle variable one way, whatever the argument is called', () => {
    for (const doc of documents) {
      expect(doc.variables, doc.operationName).toHaveProperty('vehicleId', 'veh')
      expect(doc.query, doc.operationName).not.toMatch(/\$(id|vehicleID)\b/)
    }
  })

  it('puts one field on each line, and never two selections on one', () => {
    for (const doc of documents) {
      for (const line of doc.query.split('\n').slice(1)) {
        // After the header, a line is a field (maybe opening a block), a fragment
        // opener, or a closing brace: never `a { b c }`.
        expect(line, `${doc.operationName}: ${line}`).toMatch(
          /^ *(?:\}|(?:\.\.\. on \w+|\w+(?:\([^)]*\))?)(?: \{)?)$/,
        )
      }
    }
  })
})
