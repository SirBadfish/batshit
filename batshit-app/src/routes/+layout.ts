export const load = async ({ data }: { data: any }) => {
  // Pass through all server data including user from auth
  return {
    ...data
  }
}