// AudioWorkletGlobalScope is not part of lib.dom, so the worklet's globals are
// declared here rather than pulled in from a types package.
declare const sampleRate: number
declare const currentTime: number

interface AudioWorkletProcessorOptions {
  processorOptions?: unknown
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletProcessorOptions)
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

// `any` here is deliberate: each processor narrows its own processorOptions
// shape, and a stricter parameter type makes those subclasses unassignable.
declare function registerProcessor(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (options?: any) => AudioWorkletProcessor,
): void
