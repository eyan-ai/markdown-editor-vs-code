(function () {
  'use strict'

  var state = { mode: 'preview', theme: 'default', pinned: false, vscodeDark: false, renderTheme: null, renderEditor: null }
  var outline
  var handle
  var menu
  var hoverBlock
  var hideHandleTimer
  var enhanceTimer
  var savedInsertRange
  var savedTableRange
  var lastTableCell
  var splitScrollFrame
  var splitScrollPending
  var splitExpectedScroll = new WeakMap()
  var splitDivider
  var splitEditingAnchor
  var splitEditingTimer
  var yamlOverlayMap = new Map()
  var chartResizeObserver
  var chartResizeFrame

  function getEditor() {
    if (window.vditor && window.vditor.vditor) return window.vditor
    try {
      if (typeof vditor !== 'undefined' && vditor && vditor.vditor) return vditor
    } catch (_) {}
    return null
  }
  function getReset() {
    if (state.mode === 'split') {
      return document.querySelector('.vditor-preview .vditor-reset') || document.querySelector('.vditor-sv.vditor-reset')
    }
    return document.querySelector('.vditor-ir .vditor-reset') || document.querySelector('.vditor-wysiwyg .vditor-reset')
  }

  function switchVditorMode(editor, mode) {
    if (editor.getCurrentMode && editor.getCurrentMode() === mode) return true
    var button = document.querySelector('.vditor-toolbar button[data-mode="' + mode + '"]')
    if (!button) return false
    button.click()
    return !editor.getCurrentMode || editor.getCurrentMode() === mode
  }

  function guardReadonlySurface() {
    var reset = state.mode === 'split'
      ? document.querySelector('.vditor-sv.vditor-reset')
      : document.querySelector('.vditor-ir .vditor-reset') || document.querySelector('.vditor-wysiwyg .vditor-reset')
    if (!reset) return
    if (!reset.dataset.eyanReadonlyGuard) {
      var stopVditorEdit = function (event) {
        if (state.mode !== 'readonly') return
        var target = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement)
        var link = target && (target.closest('a') || target.closest('[data-type="a"]'))
        if (!link) event.stopPropagation()
      }
      reset.addEventListener('mousedown', stopVditorEdit, true)
      reset.addEventListener('dblclick', stopVditorEdit, true)
      reset.addEventListener('click', stopVditorEdit, true)
      reset.addEventListener('keydown', function (event) {
        if (state.mode !== 'readonly') return
        if (!(event.ctrlKey || event.metaKey) || !['a', 'c', 'f'].includes(event.key.toLowerCase())) event.stopPropagation()
      }, true)
      reset.dataset.eyanReadonlyGuard = '1'
    }
    var editable = state.mode !== 'readonly' ? 'true' : 'false'
    // Rewriting contenteditable on every character mutation resets the caret in
    // VS Code's webview. Only touch these attributes when their value changed.
    if (reset.getAttribute('contenteditable') !== editable) reset.setAttribute('contenteditable', editable)
    if (reset.getAttribute('spellcheck') !== 'false') reset.setAttribute('spellcheck', 'false')
  }

  function clearInlineEditingState() {
    document.querySelectorAll('.vditor-ir__node--expand').forEach(function (node) {
      node.classList.remove('vditor-ir__node--expand')
    })
    var selection = window.getSelection()
    if (selection) selection.removeAllRanges()
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur()
  }

  function syncVditorRenderTheme() {
    var editor = getEditor()
    if (!editor || typeof editor.setTheme !== 'function') return
    var renderTheme = state.theme === 'default' && state.vscodeDark ? 'dark' : 'light'
    var editorChanged = state.renderEditor !== editor
    if (!editorChanged && state.renderTheme === renderTheme) return
    state.renderEditor = editor
    state.renderTheme = renderTheme
    editor.setTheme(renderTheme === 'dark' ? 'dark' : 'classic', renderTheme)

    // Rendered diagrams bake their palette into canvas or SVG output, so rebuild
    // them only when the actual document surface changes between light and dark.
    var diagramSelector = '.language-mermaid, .language-flowchart, .language-graphviz, .language-markmap, .language-mindmap, .language-echarts'
    if (!document.querySelector(diagramSelector)) return
    var scrollSurface = document.querySelector('.vditor-ir, .vditor-preview')
    var scrollTop = scrollSurface ? scrollSurface.scrollTop : 0
    try {
      editor.setValue(editor.getValue(), false)
      requestAnimationFrame(function () {
        if (scrollSurface) scrollSurface.scrollTop = scrollTop
      })
    } catch (error) {
      console.warn('[Markdown Editor] diagram theme refresh failed', error)
    }
  }

  function applyTheme(theme) {
    state.theme = ['default', 'pine', 'red', 'orange', 'green'].indexOf(theme) >= 0 ? theme : 'default'
    // html 也要挂主题类：html 的背景走 :root 的 --eyan-surface（VS Code 背景），
    // 不挂类的话深色 VS Code 下打开浅色主题会先闪黑
    ;[document.documentElement, document.body].forEach(function (surface) {
      surface.classList.remove('eyan-theme-pine', 'eyan-theme-red', 'eyan-theme-orange', 'eyan-theme-green')
      if (state.theme !== 'default') surface.classList.add('eyan-theme-' + state.theme)
    })
    syncVditorRenderTheme()
    enhanceContent()
    buildOutline()
  }

  function applyVscodeTheme(theme) {
    state.vscodeDark = theme === 'dark'
    document.body.classList.toggle('eyan-vscode-dark', state.vscodeDark)
  }

  function applyMode(mode, attempt) {
    mode = ['preview', 'split', 'readonly'].indexOf(mode) >= 0 ? mode : 'preview'
    state.mode = mode
    var editor = getEditor()
    if (!editor) {
      if ((attempt || 0) < 150) setTimeout(function () { applyMode(mode, (attempt || 0) + 1) }, 100)
      return
    }
    document.body.classList.toggle('eyan-mode-readonly', state.mode === 'readonly')
    document.body.classList.toggle('eyan-mode-split', state.mode === 'split')
    if (state.mode !== 'split') {
      splitEditingAnchor = null
      if (splitDivider && splitDivider.parentNode) splitDivider.parentNode.removeChild(splitDivider)
    }
    if (menu) menu.style.display = 'none'
    if (handle) handle.style.display = 'none'
    try {
      if (state.mode === 'split') {
        if (!switchVditorMode(editor, 'sv')) throw new Error('Split mode control is unavailable')
        editor.enable()
      } else {
        if (!switchVditorMode(editor, 'ir')) throw new Error('Preview mode control is unavailable')
        if (state.mode === 'readonly') {
          if (typeof editor.blur === 'function') editor.blur()
          clearInlineEditingState()
          editor.disabled()
        } else editor.enable()
      }
    } catch (error) {
      console.warn('[Markdown Editor] mode switch failed', error)
    }
    setTimeout(function () { enhanceContent(); guardReadonlySurface(); bindSplitScrollSync(); buildOutline() }, 120)
  }

  function copyText(value, button) {
    var done = function () {
      var previous = button.innerHTML
      button.textContent = '✓'
      setTimeout(function () { button.innerHTML = previous }, 1100)
    }
    var fallback = function () {
      var textarea = document.createElement('textarea')
      textarea.value = value
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      var copied = document.execCommand('copy')
      textarea.remove()
      if (copied) done()
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, fallback)
    } else {
      fallback()
    }
  }

  function addCopyButtons() {
    document.querySelectorAll('.vditor-reset pre:not(.vditor-ir__marker--pre)').forEach(function (pre) {
      if (pre.closest('[data-type="code-block"]')) return
      if (!pre.querySelector(':scope > .eyan-code-language')) {
        var codeNode = pre.querySelector(':scope > code')
        var language = codeNode && Array.from(codeNode.classList).map(function (name) {
          return name.indexOf('language-') === 0 ? name.slice(9) : ''
        }).find(Boolean)
        var languageLabel = document.createElement('span')
        languageLabel.className = 'eyan-code-language'
        languageLabel.textContent = language === 'yml' ? 'yaml' : (language === 'plaintext' ? 'text' : (language || 'text'))
        pre.insertBefore(languageLabel, pre.firstChild)
      }
      if (pre.querySelector('.vditor-copy, :scope > .eyan-copy-button')) return
      var button = document.createElement('button')
      button.className = 'eyan-copy-button'
      button.type = 'button'
      button.title = 'Copy code'
      button.setAttribute('aria-label', 'Copy code')
      button.textContent = '⧉'
      button.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation()
        var code = pre.querySelector('code')
        copyText((code || pre).textContent || '', button)
      })
      pre.appendChild(button)
    })
    document.querySelectorAll('code.language-mermaid').forEach(function (code) {
      if (code.closest('[data-type="code-block"]')) return
      var block = code.closest('.vditor-ir__node, .vditor-wysiwyg__block, [data-type="code-block"]') || code.parentElement
      var container = block.querySelector('.vditor-ir__preview, .vditor-wysiwyg__preview, .mermaid')
      if (!container || container.querySelector(':scope > .eyan-copy-button')) return
      var source = code.textContent || ''
      if (!source.trim()) return
      var button = document.createElement('button')
      button.className = 'eyan-copy-button'
      button.type = 'button'
      button.title = 'Copy Mermaid source'
      button.setAttribute('aria-label', 'Copy Mermaid source')
      button.textContent = '⧉'
      button.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation()
        copyText(source, button)
      })
      container.appendChild(button)
    })
    document.querySelectorAll('.mermaid[data-content], [data-type="mermaid"][data-content]').forEach(function (container) {
      if (container.querySelector(':scope > .eyan-copy-button')) return
      var source = container.getAttribute('data-content') || ''
      if (!source.trim()) return
      var button = document.createElement('button')
      button.className = 'eyan-copy-button'
      button.type = 'button'
      button.title = 'Copy Mermaid source'
      button.setAttribute('aria-label', 'Copy Mermaid source')
      button.textContent = '⧉'
      button.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation()
        copyText(source, button)
      })
      container.appendChild(button)
    })
  }

  function ensureCodeBlockCopyButton(block) {
    var button = block.querySelector(':scope > .eyan-code-copy-button')
    if (button) return
    button = document.createElement('button')
    button.className = 'eyan-copy-button eyan-code-copy-button'
    button.type = 'button'
    button.contentEditable = 'false'
    button.setAttribute('data-render', '1')
    button.title = 'Copy code'
    button.setAttribute('aria-label', 'Copy code')
    button.textContent = '⧉'
    button.addEventListener('mousedown', function (event) {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      var source = block.querySelector('.vditor-ir__marker--pre code')
      var preview = block.querySelector('.vditor-ir__preview code, .vditor-ir__preview')
      copyText(((source || preview) && (source || preview).textContent) || '', button)
    })
    block.appendChild(button)
  }

  function detectCodeLanguage(code) {
    if (!code) return 'text'
    if (window.hljs && typeof window.hljs.highlightAuto === 'function') {
      try {
        var result = window.hljs.highlightAuto(code)
        var lang = result && result.language
        var relevance = result && result.relevance
        if (lang && relevance >= 3) return lang === 'plaintext' ? 'text' : lang
      } catch (e) {}
    }
    var trimmed = String(code).trim()
    if (/^[\[{]/.test(trimmed)) {
      try { JSON.parse(trimmed); return 'json' } catch (e) {}
    }
    if (/^<\?xml|^<!DOCTYPE|^<html\b/i.test(trimmed)) return 'html'
    var keyValLines = trimmed.split('\n').filter(function (l) { return /^[\w.-]+\s*:(\s|$)/.test(l) })
    if (keyValLines.length >= 2) return 'yaml'
    if (/^#{1,6}\s|\n#{1,6}\s|^\s*[-*+]\s|\n\s*[-*+]\s|^\s*\|.*\|/m.test(trimmed)) return 'markdown'
    return 'text'
  }

  function enhanceCodeBlocks() {
    document.querySelectorAll('.vditor-ir [data-type="code-block"]').forEach(function (block) {
      var source = block.querySelector('.vditor-ir__marker--pre code')
      var preview = block.querySelector('.vditor-ir__preview')
      if (!source || !preview) return
      var info = block.querySelector('[data-type="code-block-info"]')
      var label = ''
      if (info) {
        var rawLang = (info.textContent || '').replace(/\u200B/g, '').trim()
        label = rawLang
        if (!rawLang) label = detectCodeLanguage((source.textContent || '').trim())
        else if (rawLang.toLowerCase() === 'yml') label = 'yaml'
        if ((info.textContent || '').replace(/\u200B/g, '') !== label) info.textContent = '\u200B' + label
      }
      // \u56FE\u8868\u7C7B\u4EE3\u7801\u5757\uFF08mermaid/flowchart/graphviz/echarts\uFF09\u6298\u53E0\u6001\u53EA\u6E32\u67D3\u56FE\u8868\u672C\u8EAB\uFF0C
      // \u4E0D\u52A0\u4EE3\u7801\u5757\u8FB9\u6846\u3001\u8BED\u8A00\u8868\u5934\u3001\u590D\u5236\u6309\u94AE\u548C\u884C\u53F7\u3002
      var langLower = label.toLowerCase()
      var isDiagram = langLower === 'mermaid' || langLower === 'flowchart' || langLower === 'graphviz' || langLower === 'echarts'
      block.classList.toggle('eyan-diagram-block', isDiagram)
      ensureCodeBlockCopyButton(block)
      if (isDiagram) return
      var lineCount = Math.max(1, (source.textContent || '').replace(/\n$/, '').split('\n').length)
      var gutter = preview.querySelector(':scope > .eyan-code-line-numbers')
      if (!gutter) {
        gutter = document.createElement('span')
        gutter.className = 'eyan-code-line-numbers'
        gutter.setAttribute('aria-hidden', 'true')
        preview.appendChild(gutter)
      }
      var signature = String(lineCount)
      if (gutter.dataset.lines === signature) return
      gutter.dataset.lines = signature
      gutter.innerHTML = Array.from({ length: lineCount }, function (_, index) {
        return '<span>' + (index + 1) + '</span>'
      }).join('')
    })
  }

  function escapeYamlHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function yamlHighlightHTML(text) {
    // key（第一个 : 之前）用高亮色，其余（含 : 与值）用普通颜色。
    var html = []
    String(text).split('\n').forEach(function (line) {
      var idx = line.indexOf(':')
      if (idx > 0) {
        html.push('<span class="eyan-yaml-key">' + escapeYamlHtml(line.slice(0, idx)) + '</span>' + escapeYamlHtml(line.slice(idx)))
      } else {
        html.push(escapeYamlHtml(line))
      }
    })
    return html.join('\n')
  }

  function ensureYamlOverlayLayer() {
    var ir = document.querySelector('.vditor-ir')
    if (!ir) return null
    var layer = ir.querySelector(':scope > #eyan-yaml-overlay-layer')
    if (!layer) {
      layer = document.createElement('div')
      layer.id = 'eyan-yaml-overlay-layer'
      ir.appendChild(layer)
    }
    return layer
  }

  function positionYamlOverlays(updateContent) {
    if (yamlOverlayMap.size === 0) return
    var ir = document.querySelector('.vditor-ir')
    if (!ir) return
    var irRect = ir.getBoundingClientRect()
    yamlOverlayMap.forEach(function (overlay, node) {
      if (!node.isConnected) {
        overlay.remove()
        yamlOverlayMap.delete(node)
        return
      }
      var code = node.querySelector('.vditor-ir__marker--pre code')
      if (!code) return
      var editing = node.classList.contains('eyan-yaml-editing')
      if (editing) {
        overlay.style.display = 'none'
        return
      }
      if (updateContent !== false) {
        var text = code.textContent
        if (overlay.dataset.signature !== text) {
          overlay.dataset.signature = text
          overlay.innerHTML = yamlHighlightHTML(text)
        }
      }
      var r = code.getBoundingClientRect()
      overlay.style.display = 'block'
      overlay.style.top = (r.top - irRect.top) + 'px'
      overlay.style.left = (r.left - irRect.left) + 'px'
      overlay.style.width = r.width + 'px'
      overlay.style.height = r.height + 'px'
    })
  }

  function enhanceFrontMatter() {
    // GitHub 风格：顶部 YAML 始终以「卡片」展示源码（--- 标记 + 等宽字体），
    // 键值着色由 .eyan-yaml-highlight 覆盖层实现（不进入 Vditor 序列化 DOM）。
    var layer = ensureYamlOverlayLayer()
    document.querySelectorAll('.vditor-ir div[data-type="yaml-front-matter"]').forEach(function (node) {
      node.classList.add('vditor-ir__node--expand')
      if (!yamlOverlayMap.has(node)) {
        var overlay = document.createElement('div')
        overlay.className = 'eyan-yaml-highlight'
        overlay.setAttribute('aria-hidden', 'true')
        if (layer) layer.appendChild(overlay)
        yamlOverlayMap.set(node, overlay)
      }
      if (node.dataset.eyanFrontMatterBound) return
      node.dataset.eyanFrontMatterBound = '1'
      node.addEventListener('click', function (event) {
        if (state.mode === 'readonly') return
        node.classList.add('eyan-yaml-editing')
        positionYamlOverlays(false)
        var editor = getEditor()
        if (editor) editor.focus()
        var pre = node.querySelector('.vditor-ir__marker--pre')
        if (pre && !pre.contains(event.target)) {
          var range = document.createRange()
          range.selectNodeContents(pre)
          range.collapse(false)
          var selection = window.getSelection()
          if (selection) {
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      })
    })
    positionYamlOverlays()
  }

  function resolveCustomColor(element, variable, fallback) {
    var probe = document.createElement('span')
    probe.style.position = 'fixed'
    probe.style.visibility = 'hidden'
    probe.style.pointerEvents = 'none'
    probe.style.color = 'var(' + variable + ')'
    document.body.appendChild(probe)
    var value = getComputedStyle(probe).color
    probe.remove()
    return value || fallback
  }

  function syncRenderedChartColors() {
    if (!window.echarts || typeof window.echarts.getInstanceByDom !== 'function') return
    var reset = getReset()
    if (!reset) return
    var styles = getComputedStyle(reset)
    var surface = styles.backgroundColor
    var text = styles.color
    var muted = resolveCustomColor(reset, '--eyan-muted', text)
    var border = resolveCustomColor(reset, '--eyan-border', muted)
    var signature = [surface, text, muted, border].join('|')

    document.querySelectorAll('.vditor-ir__preview .language-echarts, .vditor-wysiwyg__preview .language-echarts, .vditor-preview .language-echarts').forEach(function (element) {
      var chart = window.echarts.getInstanceByDom(element)
      if (!chart || element.dataset.eyanChartPalette === signature) return
      var option = chart.getOption()
      var patch = {
        backgroundColor: surface,
        textStyle: { color: text }
      }
      if (option.title && option.title.length) {
        patch.title = option.title.map(function () {
          return { textStyle: { color: text }, subtextStyle: { color: muted } }
        })
      }
      if (option.legend && option.legend.length) {
        patch.legend = option.legend.map(function () { return { textStyle: { color: text } } })
      }
      var axisNames = ['xAxis', 'yAxis', 'radiusAxis', 'angleAxis', 'singleAxis']
      axisNames.forEach(function (axisName) {
        if (!option[axisName] || !option[axisName].length) return
        patch[axisName] = option[axisName].map(function () {
          return {
            axisLabel: { color: muted },
            axisLine: { lineStyle: { color: border } },
            splitLine: { lineStyle: { color: border } },
            nameTextStyle: { color: text }
          }
        })
      })
      chart.setOption(patch, false, true)
      element.dataset.eyanChartPalette = signature
    })
  }

  function resizeRenderedCharts() {
    chartResizeFrame = null
    if (!window.echarts || typeof window.echarts.getInstanceByDom !== 'function') return
    document.querySelectorAll('.vditor-ir__preview .language-echarts, .vditor-wysiwyg__preview .language-echarts, .vditor-preview .language-echarts').forEach(function (element) {
      var chart = window.echarts.getInstanceByDom(element)
      if (chart && element.clientWidth > 0 && element.clientHeight > 0) chart.resize()
    })
  }

  function scheduleRenderedChartResize() {
    if (chartResizeFrame) cancelAnimationFrame(chartResizeFrame)
    chartResizeFrame = requestAnimationFrame(resizeRenderedCharts)
  }

  function observeRenderedChartSizes() {
    var elements = document.querySelectorAll('.vditor-ir__preview .language-echarts, .vditor-wysiwyg__preview .language-echarts, .vditor-preview .language-echarts')
    if (typeof ResizeObserver === 'function') {
      if (!chartResizeObserver) {
        chartResizeObserver = new ResizeObserver(function () {
          scheduleRenderedChartResize()
        })
      }
      chartResizeObserver.disconnect()
      elements.forEach(function (element) {
        chartResizeObserver.observe(element)
      })
    }
    scheduleRenderedChartResize()
  }

  function ensureOutline() {
    if (outline) return
    outline = document.createElement('aside')
    outline.id = 'eyan-outline'
    outline.innerHTML = '<div id="eyan-outline-rail"></div><div id="eyan-outline-panel"><div class="eyan-outline-header"><span>Outline</span><button id="eyan-outline-pin" title="Pin outline" aria-label="Pin outline"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-3 1-3 3 1 5-2 2-3-5-5-3 2-2 5 1 3-3 1-3Z"></path><path d="m9 15-5 5"></path></svg></button></div><div id="eyan-outline-list"></div></div>'
    document.body.appendChild(outline)
    outline.addEventListener('mouseleave', function () {
      outline.classList.remove('eyan-collapse-now')
    })
    outline.querySelector('#eyan-outline-pin').addEventListener('click', function () {
      state.pinned = !state.pinned
      outline.classList.toggle('eyan-pinned', state.pinned)
      outline.classList.toggle('eyan-collapse-now', !state.pinned)
      document.body.classList.toggle('eyan-outline-pinned', state.pinned)
      this.innerHTML = state.pinned ? '<span aria-hidden="true">&times;</span>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-3 1-3 3 1 5-2 2-3-5-5-3 2-2 5 1 3-3 1-3Z"></path><path d="m9 15-5 5"></path></svg>'
      this.title = state.pinned ? 'Close pinned outline' : 'Pin outline'
    })
  }

  function cleanHeading(text) { return (text || '').replace(/^#{1,6}\s*/, '').trim() }

  function getSplitHeadingAnchors(surface, source) {
    if (!surface) return []
    if (source) {
      return Array.from(surface.children).filter(function (block) {
        return block.querySelector('[data-type="heading-marker"]')
      })
    }
    return Array.from(surface.querySelectorAll('.vditor-reset h1, .vditor-reset h2, .vditor-reset h3, .vditor-reset h4, .vditor-reset h5, .vditor-reset h6'))
  }

  function getAnchorTop(surface, anchor) {
    return anchor.getBoundingClientRect().top - surface.getBoundingClientRect().top + surface.scrollTop
  }

  function ensureSplitDivider() {
    if (state.mode !== 'split') return
    var content = document.querySelector('.vditor-content')
    var source = document.querySelector('.vditor-sv')
    var preview = document.querySelector('.vditor-preview')
    if (!content || !source || !preview) return
    if (!splitDivider) {
      splitDivider = document.createElement('div')
      splitDivider.id = 'eyan-split-divider'
      splitDivider.setAttribute('role', 'separator')
      splitDivider.setAttribute('aria-orientation', 'vertical')
      splitDivider.setAttribute('aria-label', 'Resize split editor')
      splitDivider.addEventListener('pointerdown', function (event) {
        if (window.innerWidth <= 820) return
        var currentContent = document.querySelector('.vditor-content')
        var currentSource = document.querySelector('.vditor-sv')
        if (!currentContent || !currentSource || splitDivider.parentNode !== currentContent) return
        event.preventDefault()
        event.stopPropagation()
        splitDivider.classList.add('eyan-dragging')
        document.body.classList.add('eyan-split-resizing')
        var rect = currentContent.getBoundingClientRect()
        var start = event.clientX
        var initial = currentSource.getBoundingClientRect().width
        if (splitDivider.setPointerCapture) splitDivider.setPointerCapture(event.pointerId)
        var move = function (moveEvent) {
          if (moveEvent.pointerId !== event.pointerId) return
          var minSource = 260
          var minPreview = 280
          var maxSource = Math.max(minSource, rect.width - minPreview - splitDivider.offsetWidth)
          var width = Math.max(minSource, Math.min(maxSource, initial + (moveEvent.clientX - start)))
          var ratio = (width / rect.width) * 100
          currentContent.style.setProperty('--eyan-split-source-width', ratio + '%')
          splitDivider.setAttribute('aria-valuenow', String(Math.round(width)))
        }
        var up = function (upEvent) {
          if (upEvent && upEvent.pointerId !== event.pointerId) return
          splitDivider.classList.remove('eyan-dragging')
          document.body.classList.remove('eyan-split-resizing')
          splitDivider.removeEventListener('pointermove', move)
          splitDivider.removeEventListener('pointerup', up)
          splitDivider.removeEventListener('pointercancel', up)
          splitDivider.removeEventListener('lostpointercapture', up)
          if (splitDivider.hasPointerCapture && splitDivider.hasPointerCapture(event.pointerId)) {
            splitDivider.releasePointerCapture(event.pointerId)
          }
        }
        splitDivider.addEventListener('pointermove', move)
        splitDivider.addEventListener('pointerup', up)
        splitDivider.addEventListener('pointercancel', up)
        splitDivider.addEventListener('lostpointercapture', up)
      })
    }
    if (splitDivider.parentNode !== content) content.insertBefore(splitDivider, preview)
    if (!content.style.getPropertyValue('--eyan-split-source-width')) content.style.setProperty('--eyan-split-source-width', '50%')
  }

  function findDirectChild(surface, node) {
    var current = node
    while (current && current.parentNode !== surface) current = current.parentNode
    return current && current.parentNode === surface ? current : null
  }

  function getPreviewBlockForSource(sourceBlock) {
    var preview = document.querySelector('.vditor-preview')
    var reset = preview && preview.querySelector('.vditor-reset')
    if (!sourceBlock || !reset) return null
    var source = document.querySelector('.vditor-sv')
    var index = Array.prototype.indexOf.call(source.children, sourceBlock)
    if (index < 0) return null
    // 左栏 frontmatter 块与右栏 pre.vditor-yml-front-matter 一一对应，索引可直接映射
    return reset.children[Math.min(index, reset.children.length - 1)] || null
  }

  function syncEditingAnchor() {
    if (!splitEditingAnchor || state.mode !== 'split') return
    var source = document.querySelector('.vditor-sv')
    var preview = document.querySelector('.vditor-preview')
    var previewBlock = getPreviewBlockForSource(splitEditingAnchor.block)
    if (!source || !preview || !previewBlock) return
    var sourceRect = splitEditingAnchor.block.getBoundingClientRect()
    var sourceViewportCenter = source.getBoundingClientRect().top + source.clientHeight / 2
    var previewBlockCenter = getAnchorTop(preview, previewBlock) + previewBlock.offsetHeight / 2
    // Keep the edited block in the same visual band in both panes. Centering the
    // anchor avoids the left pane reaching its scroll limit while the right pane
    // still has the edited block below the fold.
    var sourceCenterOffset = sourceRect.top + sourceRect.height / 2 - sourceViewportCenter
    setProgrammaticScroll(preview, previewBlockCenter - preview.clientHeight / 2 - sourceCenterOffset)
  }

  function bindSplitEditingAnchor() {
    if (state.mode !== 'split') return
    var source = document.querySelector('.vditor-sv')
    if (!source || source.dataset.eyanEditingAnchorBound) return
    source.dataset.eyanEditingAnchorBound = '1'
    source.addEventListener('focusin', function (event) {
      var block = findDirectChild(source, event.target)
      if (!block) return
      clearTimeout(splitEditingTimer)
      splitEditingAnchor = { block: block }
      requestAnimationFrame(syncEditingAnchor)
    })
    source.addEventListener('input', function () {
      if (!splitEditingAnchor) return
      clearTimeout(splitEditingTimer)
      requestAnimationFrame(syncEditingAnchor)
    })
    source.addEventListener('focusout', function () {
      clearTimeout(splitEditingTimer)
      splitEditingTimer = setTimeout(function () {
        if (!source.contains(document.activeElement)) splitEditingAnchor = null
      }, 260)
    })
  }

  function clampScroll(surface, value) {
    return Math.max(0, Math.min(value, Math.max(0, surface.scrollHeight - surface.clientHeight)))
  }

  function setProgrammaticScroll(surface, value) {
    var top = clampScroll(surface, value)
    splitExpectedScroll.set(surface, top)
    surface.scrollTop = top
  }

  function scrollToHeadingIndex(index) {
    if (state.mode !== 'split') return false
    var source = document.querySelector('.vditor-sv')
    var preview = document.querySelector('.vditor-preview')
    if (!source || !preview) return false
    var sourceHeadings = getSplitHeadingAnchors(source, true)
    var previewHeadings = getSplitHeadingAnchors(preview, false)
    var sourceHeading = sourceHeadings[index]
    var previewHeading = previewHeadings[index]
    if (!sourceHeading && !previewHeading) return false
    if (sourceHeading) setProgrammaticScroll(source, getAnchorTop(source, sourceHeading) - 24)
    if (previewHeading) setProgrammaticScroll(preview, getAnchorTop(preview, previewHeading) - 24)
    return true
  }

  function buildOutline() {
    ensureOutline()
    var reset = getReset()
    if (!reset) return
    var headings = Array.from(reset.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    var rail = outline.querySelector('#eyan-outline-rail')
    var list = outline.querySelector('#eyan-outline-list')
    rail.innerHTML = ''
    list.innerHTML = ''
    headings.forEach(function (heading, index) {
      var tick = document.createElement('span')
      tick.className = 'eyan-outline-tick' + (index === 0 ? ' eyan-active' : '')
      rail.appendChild(tick)
      var item = document.createElement('button')
      item.className = 'eyan-outline-item' + (index === 0 ? ' eyan-active' : '')
      item.dataset.level = heading.tagName.slice(1)
      item.textContent = cleanHeading(heading.textContent)
      item.addEventListener('click', function () {
        setOutlineActive(index)
        if (!scrollToHeadingIndex(index)) heading.scrollIntoView({ behavior: 'auto', block: 'start' })
      })
      list.appendChild(item)
    })
  }

  function setOutlineActive(index) {
    if (!outline) return
    outline.querySelectorAll('.eyan-outline-item').forEach(function (item, i) { item.classList.toggle('eyan-active', i === index) })
    outline.querySelectorAll('.eyan-outline-tick').forEach(function (tick, i) { tick.classList.toggle('eyan-active', i === index) })
  }

  function updateOutlineActive() {
    if (!outline) return
    var reset = getReset()
    if (!reset) return
    var headings = Array.from(reset.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    var active = 0
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= 120) active = i
    }
    setOutlineActive(active)
  }

  function ensureBlockMenu() {
    if (handle) return
    handle = document.createElement('button')
    handle.id = 'eyan-block-handle'
    handle.type = 'button'
    handle.textContent = '+'
    handle.title = 'Click to add'
    document.body.appendChild(handle)
    menu = document.createElement('div')
    menu.id = 'eyan-block-menu'
    var actions = [
      ['Heading', '\n## New heading\n'], ['Bulleted list', '\n- List item\n'], ['Numbered list', '\n1. First step\n'],
      ['To-do list', '\n- [ ] Todo\n'], ['Quote', '\n> Write a quote here.\n'], ['Code block', '\n```\n// code goes here\n```\n'],
      ['Link', '[Link text](https://example.com)'], ['Divider', '\n\n***\n\n']
    ]
    actions.forEach(function (entry) {
      var item = document.createElement('button')
      item.className = 'eyan-block-menu-item'
      item.type = 'button'
      item.textContent = entry[0]
      item.addEventListener('mousedown', function (event) {
        // Keep Vditor's current caret/range when the menu item is pressed.
        event.preventDefault()
      })
      item.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var editor = getEditor()
        if (editor) {
          editor.focus()
          restoreInsertRange()
          // execCommand can report success while leaving IR mode unchanged. Vditor's
          // Markdown insertion API performs the required parse and keeps the caret.
          if (typeof editor.insertMD === 'function') editor.insertMD(entry[1])
          else editor.insertValue(entry[1])
        }
        menu.style.display = 'none'
        handle.style.display = 'none'
      })
      menu.appendChild(item)
    })
    document.body.appendChild(menu)
    handle.addEventListener('mouseenter', function () {
      clearTimeout(hideHandleTimer)
    })
    handle.addEventListener('mouseleave', function () {
      clearTimeout(hideHandleTimer)
      hideHandleTimer = setTimeout(function () {
        if (menu.style.display !== 'block') {
          handle.style.display = 'none'
          hoverBlock = null
        }
      }, 180)
    })
    handle.addEventListener('click', function (event) {
      event.stopPropagation()
      clearTimeout(hideHandleTimer)
      var rect = handle.getBoundingClientRect()
      positionFloatingMenu(rect)
    })
    menu.addEventListener('mouseenter', function () {
      clearTimeout(hideHandleTimer)
    })
    handle.addEventListener('mousedown', function (event) {
      // Do not let the gutter control steal the editor selection.
      event.preventDefault()
      saveInsertRange()
      if (hoverBlock && (!savedInsertRange || !hoverBlock.contains(savedInsertRange.startContainer))) {
        var walker = document.createTreeWalker(hoverBlock, NodeFilter.SHOW_TEXT)
        var lastText = null
        while (walker.nextNode()) lastText = walker.currentNode
        if (lastText) {
          savedInsertRange = document.createRange()
          savedInsertRange.setStart(lastText, lastText.textContent.length)
          savedInsertRange.collapse(true)
        } else {
          var emptyRange = document.createRange()
          emptyRange.selectNodeContents(hoverBlock)
          emptyRange.collapse(true)
          savedInsertRange = emptyRange
        }
      }
    })
    document.addEventListener('click', function (event) {
      if (!menu.contains(event.target) && event.target !== handle) menu.style.display = 'none'
    })
  }

  function saveInsertRange() {
    var selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    try { savedInsertRange = selection.getRangeAt(0).cloneRange() } catch (_) {}
  }

  function restoreInsertRange() {
    if (!savedInsertRange) return
    var selection = window.getSelection()
    if (!selection) return
    try {
      selection.removeAllRanges()
      selection.addRange(savedInsertRange)
    } catch (_) {}
  }

  document.addEventListener('selectionchange', function () {
    var reset = document.querySelector('.vditor-ir .vditor-reset')
    var selection = window.getSelection()
    if (!reset || !selection || selection.rangeCount === 0 || !selection.anchorNode) return
    if (reset.contains(selection.anchorNode)) saveInsertRange()
  })

  function getCaretRangeFromPoint(x, y) {
    var range = null
    try {
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y)
      else if (document.caretPositionFromPoint) {
        var position = document.caretPositionFromPoint(x, y)
        if (position) {
          range = document.createRange()
          range.setStart(position.offsetNode, position.offset)
          range.collapse(true)
        }
      }
    } catch (_) {}
    return range
  }

  function showBlockMenu(left, top) {
    positionFloatingMenu({ left: left, right: left, top: top, bottom: top })
  }

  function positionFloatingMenu(anchorRect) {
    var gap = 6
    var edge = 8
    menu.style.visibility = 'hidden'
    menu.style.display = 'block'
    var menuRect = menu.getBoundingClientRect()
    var below = window.innerHeight - anchorRect.bottom - edge
    var above = anchorRect.top - edge
    var top = anchorRect.bottom + gap
    if (below < menuRect.height + gap && above > below) top = anchorRect.top - menuRect.height - gap
    top = Math.max(edge, Math.min(top, window.innerHeight - menuRect.height - edge))
    var left = Math.max(edge, Math.min(anchorRect.left, window.innerWidth - menuRect.width - edge))
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
    menu.style.visibility = 'visible'
  }

  function isBlockEmpty(block) {
    if (!block) return false
    return (block.textContent || '').replace(/[​ ﻿\s]/g, '') === ''
  }

  function positionHandle(left, top, height) {
    var size = 28
    handle.style.left = Math.max(4, left - size - 8) + 'px'
    handle.style.top = Math.max(4, top + height / 2 - size / 2) + 'px'
    handle.style.display = 'grid'
  }

  function showBlockHandle(block) {
    hoverBlock = block
    var rect = block.getBoundingClientRect()
    positionHandle(rect.left, rect.top, rect.height)
  }

  function showAnchorHandle(anchor) {
    hoverBlock = anchor.block
    positionHandle(anchor.left, anchor.top, anchor.height)
  }

  // 找到鼠标下方的「空行」锚点：真正的空块，或两个块之间的空白间隙（IR 折叠掉的空行）。
  function findEmptyAnchor(reset, y) {
    var blocks = Array.from(reset.children)
    for (var i = 0; i < blocks.length; i++) {
      var rect = blocks[i].getBoundingClientRect()
      if (y >= rect.top && y <= rect.bottom) {
        if (isBlockEmpty(blocks[i])) return { left: rect.left, top: rect.top, height: rect.height, block: blocks[i] }
        return null
      }
      if (y < rect.top && i > 0) {
        var prevRect = blocks[i - 1].getBoundingClientRect()
        if (rect.top - prevRect.bottom >= 8) return { left: rect.left, top: prevRect.bottom, height: rect.top - prevRect.bottom, block: blocks[i - 1] }
        return null
      }
    }
    return null
  }

  function bindBlockHover() {
    ensureBlockMenu()
    var reset = getReset()
    if (!reset || reset.dataset.eyanHoverBound) return
    reset.dataset.eyanHoverBound = '1'
    reset.addEventListener('mouseup', function (event) {
      var range = getCaretRangeFromPoint(event.clientX, event.clientY)
      if (range && reset.contains(range.startContainer)) savedInsertRange = range.cloneRange()
    })
    reset.addEventListener('mousemove', function (event) {
      if (state.mode !== 'preview') return
      clearTimeout(hideHandleTimer)
      var anchor = findEmptyAnchor(reset, event.clientY)
      if (!anchor) {
        hoverBlock = null
        if (handle.style.display !== 'none') handle.style.display = 'none'
        return
      }
      if (anchor.block === hoverBlock && handle.style.display !== 'none') return
      showAnchorHandle(anchor)
    })
    reset.addEventListener('mouseleave', function () {
      clearTimeout(hideHandleTimer)
      hideHandleTimer = setTimeout(function () {
        if (menu.style.display !== 'block') {
          handle.style.display = 'none'
          hoverBlock = null
        }
      }, 180)
    })
    reset.addEventListener('contextmenu', function (event) {
      if (state.mode !== 'preview') return
      var block = event.target.closest('.vditor-reset > *')
      if (!block) return
      event.preventDefault()
      var range = getCaretRangeFromPoint(event.clientX, event.clientY)
      if (range && reset.contains(range.startContainer)) savedInsertRange = range.cloneRange()
      showBlockHandle(block)
      handle.style.display = 'none'
      showBlockMenu(event.clientX, event.clientY)
    })
  }

  function enhanceTableEditor() {
    var reset = document.querySelector('.vditor-ir .vditor-reset')
    if (reset && !reset.dataset.eyanTableSurfaceBound) {
      reset.dataset.eyanTableSurfaceBound = '1'
      reset.addEventListener('mousedown', function (event) {
        var cell = event.target.closest('td, th')
        if (!cell) return
        lastTableCell = cell
        var selection = window.getSelection()
        if (selection && selection.rangeCount) {
          try { savedTableRange = selection.getRangeAt(0).cloneRange() } catch (_) {}
        }
      })
      reset.addEventListener('click', function (event) {
        var cell = event.target.closest('td, th')
        if (!cell) return
        lastTableCell = cell
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            var selection = window.getSelection()
            if (selection && selection.rangeCount && selection.anchorNode && cell.contains(selection.anchorNode)) {
              try { savedTableRange = selection.getRangeAt(0).cloneRange() } catch (_) {}
            }
            enhanceTableEditor()
            refreshTablePanel()
          })
        })
      })
    }
    var panel = document.querySelector('#fix-table-ir-wrapper .vditor-panel-ir')
    if (!panel || panel.dataset.eyanTableBound) return
    panel.dataset.eyanTableBound = '1'
    panel.addEventListener('mousedown', function (event) {
      // Table commands depend on the current cell selection.
      event.preventDefault()
      if (savedTableRange) {
        var selection = window.getSelection()
        if (selection) {
          try {
            selection.removeAllRanges()
            selection.addRange(savedTableRange)
          } catch (_) {}
        }
      }
    })
    var labels = {
      insertRowB: '+ Row',
      deleteRow: '- Row',
      insertColumnR: '+ Column',
      deleteColumn: '- Column'
    }
    Object.keys(labels).forEach(function (type) {
      var button = panel.querySelector('[data-type="' + type + '"]')
      if (!button) return
      button.setAttribute('aria-label', labels[type])
      button.textContent = labels[type]
    })
    new MutationObserver(function () {
      requestAnimationFrame(refreshTablePanel)
    }).observe(panel, { attributes: true, attributeFilter: ['class', 'style'] })
  }

  function refreshTablePanel() {
    var panel = document.querySelector('#fix-table-ir-wrapper .vditor-panel-ir')
    if (!panel) return
    var hidden = panel.style.display === 'none'
    if (hidden || !lastTableCell || !lastTableCell.isConnected) {
      panel.classList.remove('eyan-table-panel-visible')
      return
    }
    panel.classList.add('eyan-table-panel-visible')
    var cellRect = lastTableCell.getBoundingClientRect()
    var panelRect = panel.getBoundingClientRect()
    var gap = 6
    var edge = 8
    var below = window.innerHeight - cellRect.bottom - edge
    var above = cellRect.top - edge
    var top = cellRect.bottom + gap
    if (below < panelRect.height + gap && above > below) top = cellRect.top - panelRect.height - gap
    top = Math.max(edge, Math.min(top, window.innerHeight - panelRect.height - edge))
    var left = Math.max(edge, Math.min(cellRect.left, window.innerWidth - panelRect.width - edge))
    if (panel.style.left !== left + 'px') panel.style.left = left + 'px'
    if (panel.style.top !== top + 'px') panel.style.top = top + 'px'
  }

  function getSplitAnchorTops(surface, source) {
    var tops = getSplitHeadingAnchors(surface, source).map(function (anchor) { return getAnchorTop(surface, anchor) })
    // 虚拟文档顶部锚点：第一个标题之前的内容（如 frontmatter 区）也能按比例联动
    tops.unshift(0)
    return tops
  }

  function getScrollAnchorState(surface, tops) {
    if (!tops.length) return null
    var position = surface.scrollTop + 24
    var index = 0
    for (var i = 0; i < tops.length; i++) {
      if (tops[i] <= position) index = i
      else break
    }
    var current = tops[index]
    var next = index + 1 < tops.length ? tops[index + 1] : Math.max(current + 1, surface.scrollHeight)
    return { index: index, progress: Math.max(0, Math.min(1, (position - current) / Math.max(1, next - current))) }
  }

  function mapScrollByHeadings(from, to) {
    var fromTops = getSplitAnchorTops(from, from.classList.contains('vditor-sv'))
    var toTops = getSplitAnchorTops(to, to.classList.contains('vditor-sv'))
    var stateAtScroll = getScrollAnchorState(from, fromTops)
    if (!stateAtScroll || toTops.length < 2) {
      var fromRange = from.scrollHeight - from.clientHeight
      var toRange = to.scrollHeight - to.clientHeight
      return fromRange > 0 && toRange > 0 ? (from.scrollTop / fromRange) * toRange : 0
    }
    var index = Math.min(stateAtScroll.index, toTops.length - 1)
    var current = toTops[index]
    var next = index + 1 < toTops.length ? toTops[index + 1] : Math.max(current + 1, to.scrollHeight)
    return current + stateAtScroll.progress * Math.max(1, next - current) - 24
  }

  function queueSplitScroll(from, to) {
    if (state.mode !== 'split' || !from || !to) return
    var expected = splitExpectedScroll.get(from)
    if (typeof expected === 'number') {
      splitExpectedScroll.delete(from)
      if (Math.abs(from.scrollTop - expected) < 1) return
    }
    splitScrollPending = { from: from, to: to }
    if (splitScrollFrame) return
    splitScrollFrame = requestAnimationFrame(function () {
      splitScrollFrame = null
      var pending = splitScrollPending
      splitScrollPending = null
      if (!pending || state.mode !== 'split') return
      if (splitEditingAnchor && pending.from === document.querySelector('.vditor-sv')) {
        syncEditingAnchor()
        return
      }
      setProgrammaticScroll(pending.to, mapScrollByHeadings(pending.from, pending.to))
    })
  }

  function handleSplitScrollEvent(event) {
    if (state.mode !== 'split') return
    var source = document.querySelector('.vditor-sv')
    var preview = document.querySelector('.vditor-preview')
    if (event.target !== source && event.target !== preview) return
    // Vditor also installs percentage-based Split scroll handlers on the panes.
    // Stop those target listeners and let the heading-anchor mapping own the sync.
    event.stopPropagation()
    if (event.target === source) queueSplitScroll(source, preview)
    else queueSplitScroll(preview, source)
  }

  function bindSplitScrollSync() {
    if (state.mode !== 'split') return
    var source = document.querySelector('.vditor-sv')
    var preview = document.querySelector('.vditor-preview')
    if (!source || !preview) return
    ensureSplitDivider()
    bindSplitEditingAnchor()
    source.dataset.eyanScrollSync = '1'
    preview.dataset.eyanScrollSync = '1'
  }

  function enhanceContent() {
    ensureOutline()
    addCopyButtons()
    enhanceCodeBlocks()
    enhanceFrontMatter()
    syncRenderedChartColors()
    observeRenderedChartSizes()
    bindBlockHover()
    enhanceTableEditor()
    bindSplitScrollSync()
    guardReadonlySurface()
  }

  function scheduleEnhance() {
    clearTimeout(enhanceTimer)
    enhanceTimer = setTimeout(function () {
      enhanceContent()
      buildOutline()
    }, 80)
  }

  window.addEventListener('message', function (event) {
    var message = event.data || {}
    if (message.command === 'markdown-editor:set-mode') applyMode(message.mode)
    if (message.command === 'markdown-editor:set-theme') applyTheme(message.theme)
    if (message.command === 'update' && message.type === 'init') {
      setTimeout(function () {
        applyVscodeTheme(message.theme)
        applyTheme(message.editorTheme || state.theme)
        applyMode(message.editorMode || state.mode)
      }, 80)
    }
  })

  document.addEventListener('scroll', updateOutlineActive, true)
  document.addEventListener('scroll', handleSplitScrollEvent, true)
  document.addEventListener('scroll', function () { positionYamlOverlays(false) }, true)
  window.addEventListener('resize', function () {
    positionYamlOverlays(false)
    scheduleRenderedChartResize()
  })
  document.addEventListener('mousedown', function (event) {
    var editing = document.querySelector('.vditor-ir div[data-type="yaml-front-matter"].eyan-yaml-editing')
    if (editing && !editing.contains(event.target)) {
      editing.classList.remove('eyan-yaml-editing')
      positionYamlOverlays()
    }
  }, true)
  new MutationObserver(function () {
    scheduleEnhance()
  }).observe(document.getElementById('app'), {
    childList: true,
    subtree: true,
    characterData: true
  })
  new MutationObserver(function () {
    if (document.body.getAttribute('data-vmd-ready') === '1') scheduleEnhance()
  }).observe(document.body, { attributes: true, attributeFilter: ['data-vmd-ready'] })
})()
