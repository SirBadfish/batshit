// Kit 3 retains these runtime namespaces until Kit 4. Forward their exact declared keys.
declare module '$env/dynamic/private' {
  export const env: typeof import('$app/env/private')
}

declare module '$env/dynamic/public' {
  export const env: typeof import('$app/env/public')
}
