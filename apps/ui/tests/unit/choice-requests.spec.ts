import { describe, expect, it } from 'vitest'
import { ChoiceRequests } from '@/lib/choice-requests'

describe('ChoiceRequests', () => {
  it('sends one request per list until its answer arrives', () => {
    const requests = new ChoiceRequests()
    expect(requests.ask('keys:a.yml', 'v1')).toBe(true)
    expect(requests.ask('keys:a.yml', 'v1')).toBe(false)
    expect(requests.ask('tables:db.gz', '1')).toBe(true)

    expect(requests.settle('keys:a.yml', 'v1')).toBe(true)
    expect(requests.ask('keys:a.yml', 'v1')).toBe(true)
  })

  it('forgets an answer made for copies that changed since the request, and lets the list be asked again', () => {
    const requests = new ChoiceRequests()
    requests.ask('keys:a.yml', 'v1')

    expect(requests.settle('keys:a.yml', 'v2')).toBe(false)
    expect(requests.ask('keys:a.yml', 'v2')).toBe(true)
    expect(requests.settle('keys:a.yml', 'v2')).toBe(true)
  })

  it('never keeps a late answer of a former request once the copies changed, whatever the order of the answers', () => {
    const requests = new ChoiceRequests()
    requests.ask('keys:a.yml', 'v1')
    expect(requests.ask('keys:a.yml', 'v2')).toBe(false)

    expect(requests.settle('keys:a.yml', 'v2')).toBe(false)
    expect(requests.ask('keys:a.yml', 'v2')).toBe(true)
    expect(requests.settle('keys:a.yml', 'v2')).toBe(true)
    expect(requests.settle('keys:a.yml', 'v3')).toBe(false)
  })

  it('keeps a list on later changes of the store while its stamp holds, and tells when it went stale', () => {
    const requests = new ChoiceRequests()
    requests.ask('keys:a.yml', 'v1')
    requests.settle('keys:a.yml', 'v1')

    expect(requests.settle('keys:a.yml', 'v1')).toBe(true)
    expect(requests.isStale('keys:a.yml', 'v1')).toBe(false)
    expect(requests.isStale('keys:a.yml', 'v2')).toBe(true)
    expect(requests.isStale('keys:b.yml', 'v2')).toBe(false)
  })

  it('forgets a list nobody asked for, or whose item is gone', () => {
    const requests = new ChoiceRequests()
    expect(requests.settle('keys:a.yml', 'v1')).toBe(false)

    requests.ask('keys:b.yml', 'v1')
    expect(requests.settle('keys:b.yml', null)).toBe(false)
  })

  it('forgets everything once cleared, a kept list then being asked again', () => {
    const requests = new ChoiceRequests()
    requests.ask('keys:a.yml', 'v1')
    requests.settle('keys:a.yml', 'v1')
    requests.ask('tables:db.gz', '1')

    requests.clear()
    expect(requests.settle('keys:a.yml', 'v1')).toBe(false)
    expect(requests.ask('tables:db.gz', '1')).toBe(true)
  })
})
