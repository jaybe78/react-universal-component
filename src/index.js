// @flow
import React from 'react'
import PropTypes from 'prop-types'
import hoist from 'hoist-non-react-statics'
import req from './requireUniversalModule'

import type {
  Config,
  ConfigFunc,
  ComponentOptions,
  RequireAsync,
  State,
  Props
} from './flowTypes'

import {
  DefaultLoading,
  DefaultError,
  createDefaultRender,
  isServer
} from './utils'

export { CHUNK_NAMES, MODULE_IDS } from './requireUniversalModule'
export { default as ReportChunks } from './report-chunks'

let hasBabelPlugin = false

const isHMR = () =>
  // $FlowIgnore
  module.hot && (module.hot.data || module.hot.status() === 'apply')

export const setHasBabelPlugin = () => {
  hasBabelPlugin = true
}

export default function universal<Props: Props>(
  asyncModule: Config | ConfigFunc,
  opts: ComponentOptions = {}
) {
  const {
    render: userRender,
    loading: Loading = DefaultLoading,
    error: Err = DefaultError,
    minDelay = 0,
    alwaysDelay = false,
    testBabelPlugin = false,
    loadingTransition = true,
    ...options
  } = opts

  const render = userRender || createDefaultRender(Loading, Err)

  const isDynamic = hasBabelPlugin || testBabelPlugin
  options.isDynamic = isDynamic
  options.usesBabelPlugin = hasBabelPlugin
  options.modCache = {}
  options.promCache = {}

  return class UniversalComponent extends React.Component<void, Props, *> {
    /* eslint-disable react/sort-comp */
    _mounted: boolean
    _asyncOnly: boolean

    state: State
    props: Props
    context: Object
    /* eslint-enable react/sort-comp */

    static preload(props: Props, context: Object = {}) {
      props = props || {}
      console.log('preload props:', props)
      const { requireAsync, requireSync } = req(asyncModule, options, props)
      let mod

      try {
        mod = requireSync(props, context)
      }
      catch (error) {
        return Promise.reject(error)
      }

      return Promise.resolve()
        .then(() => {
          if (mod) return mod
          return requireAsync(props, context)
        })
        .then(mod => {
          hoist(UniversalComponent, mod, {
            preload: true,
            preloadWeak: true
          })
          return mod
        })
    }

    static preloadWeak(props: Props, context: Object = {}) {
      props = props || {}
      console.log('preloadWeak props:', props)
      const { requireSync } = req(asyncModule, options, props)

      const mod = requireSync(props, context)
      if (mod) {
        hoist(UniversalComponent, mod, {
          preload: true,
          preloadWeak: true
        })
      }

      return mod
    }

    static contextTypes = {
      store: PropTypes.object,
      report: PropTypes.func
    }

    constructor(props: Props, context: {}) {
      super(props, context)
      this.state = {
        error: null,
        context: this.context
      }
    }

    static getDerivedStateFromProps(nextProps, currentState) {
      console.log('getDerivedStateFromProps', nextProps)
      const { requireSync, shouldUpdate } = req(
        asyncModule,
        options,
        nextProps,
        currentState.props
      )
      if (isHMR() && shouldUpdate(currentState.props, nextProps)) {
        const mod = requireSync(nextProps, currentState.context)
        return { ...currentState, mod }
      }
      return null
    }

    componentDidUpdate(prevProps, prevState) {
      console.log('componentDidUpdate', prevProps)
      if (isDynamic || this._asyncOnly) {
        const { requireSync, requireAsync, shouldUpdate } = req(
          asyncModule,
          options,
          this.props,
          prevProps
        )

        if (shouldUpdate(this.props, prevProps)) {
          let mod

          try {
            mod = requireSync(this.props, this.context)
          }
          catch (error) {
            return this.update({ error })
          }

          this.handleBefore(false, !!mod)

          if (!mod) {
            return this.requireAsync(requireAsync, this.props)
          }

          const state = { mod }

          if (alwaysDelay) {
            if (loadingTransition) this.update({ mod: null }) // display `loading` during componentWillReceiveProps
            setTimeout(() => this.update(state, false, true), minDelay)
            return
          }

          this.update(state, false, true)
        }
      }
    }

    componentDidMount() {
      this._mounted = true
      const { addModule, requireSync, requireAsync, asyncOnly } = req(
        asyncModule,
        options,
        this.props
      )
      console.log('componentDidMount:', this.props)
      let mod

      try {
        mod = requireSync(this.props, this.context)
      }
      catch (error) {
        return this.update({ error })
      }

      this._asyncOnly = asyncOnly
      const chunkName = addModule(this.props) // record the module for SSR flushing :)

      if (this.context.report) {
        this.context.report(chunkName)
      }

      if (mod || isServer) {
        this.handleBefore(true, true, isServer)
        this.update({ mod }, true, true, isServer)
        return
      }

      this.handleBefore(true, false)
      this.requireAsync(requireAsync, this.props, true)
    }

    componentWillUnmount() {
      this._mounted = false
    }

    requireAsync(requireAsync: RequireAsync, props: Props, isMount?: boolean) {
      if (this.state.mod && loadingTransition) {
        this.update({ mod: null }) // display `loading` during componentWillReceiveProps
      }
      console.log('requireAsync:')
      const time = new Date()

      requireAsync(props, this.context)
        .then((mod: ?any) => {
          const state = { mod }
          console.log('Within requireAsync')
          const timeLapsed = new Date() - time
          if (timeLapsed < minDelay) {
            const extraDelay = minDelay - timeLapsed
            return setTimeout(() => this.update(state, isMount), extraDelay)
          }

          this.update(state, isMount)
        })
        .catch(error => this.update({ error }))
    }

    update = (
      state: State,
      isMount?: boolean = false,
      isSync?: boolean = false,
      isServer?: boolean = false
    ) => {
      if (!this._mounted) return
      if (!state.error) state.error = null

      this.handleAfter(state, isMount, isSync, isServer)
    }

    handleBefore(
      isMount: boolean,
      isSync: boolean,
      isServer?: boolean = false
    ) {
      if (this.props.onBefore) {
        const { onBefore } = this.props
        const info = { isMount, isSync, isServer }
        onBefore(info)
      }
    }

    handleAfter(
      state: State,
      isMount: boolean,
      isSync: boolean,
      isServer: boolean
    ) {
      const { mod, error } = state
      console.log('handleAfter')
      if (mod && !error) {
        hoist(UniversalComponent, mod, {
          preload: true,
          preloadWeak: true
        })

        if (this.props.onAfter) {
          const { onAfter } = this.props
          const info = { isMount, isSync, isServer }
          onAfter(info, mod)
        }
      }
      else if (error && this.props.onError) {
        this.props.onError(error)
      }

      this.setState(state)
    }

    render() {
      const { isLoading, error: userError, ...props } = this.props
      const { mod, error } = this.state
      return render(props, mod, isLoading, userError || error)
    }
  }
}
