import { useEffect, useRef } from 'react'
import { InputManager, type InputOptions } from './InputManager'

/**
 * Installs the app's input capture for the life of the component.
 *
 * Options are pushed into the manager on every render but the listeners are
 * attached once, so handlers stay current without the capture being torn down
 * and re-installed while a key is held.
 */
export function useInput(options: InputOptions) {
  const manager = useRef<InputManager>(null)
  if (manager.current === null) manager.current = new InputManager()

  manager.current.setOptions(options)

  useEffect(() => {
    const input = manager.current!
    const detach = input.attach()
    return () => {
      input.releaseAll()
      detach()
    }
  }, [])
}
