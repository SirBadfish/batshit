import { writable } from 'svelte/store'

export const page = writable({
  data: {
    user: {
      id: 'josh',
    },
  },
  params: {},
  route: {
    id: null,
  },
  status: 200,
  url: new URL('http://localhost/'),
  error: null,
  form: null,
})

export const navigating = writable(null)

const updatedStore = writable(false)

export const updated = {
  subscribe: updatedStore.subscribe,
  check: async () => false,
}
