import { isHairSnapshotKey } from '../../backupHairSnapshot'

/** Test-local node-redis reply adapter. It exercises archive/classification callers, not Lua
 * atomicity. The real lane never installs it; an owned actual Redis cut remains required. */
export async function fakeHairSnapshotAnswer(client: any) {
  const rows: unknown[] = ['OK']
  for (const key of (await client.keys('*')).filter(isHairSnapshotKey).sort()) {
    const type = String(await client.type(key))
    let payload: unknown
    if (type === 'json' || type === 'ReJSON-RL') payload = JSON.stringify(await client.json.get(key))
    else if (type === 'string') payload = await client.get(key)
    else if (type === 'set') payload = await client.sMembers(key)
    else if (type === 'list') payload = await client.lRange(key, 0, -1)
    else if (type === 'hash') payload = Object.entries(await client.hGetAll(key)).flat()
    else if (type === 'zset') payload = (await client.zRangeWithScores(key, 0, -1)).flatMap((entry: any) => [entry.value, String(entry.score)])
    else throw new Error(`Test Hair snapshot does not support ${type}`)
    rows.push([key, type === 'ReJSON-RL' ? 'json' : type, await client.ttl(key), payload])
  }
  return rows
}
