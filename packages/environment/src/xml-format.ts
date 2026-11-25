import { type Document, DOMImplementation, DOMParser, type Element, type Node, onErrorStopParsing, XMLSerializer } from '@xmldom/xmldom'
import type { ConfigFormat, KeyChange } from './config-merge.js'

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const TEXT_KEY = '#text'
const DEFAULT_INDENT = '  '

/** The value of an element: its text, or a map of its attributes (`@name`), children and text (`#text`). */
type XmlValue = string | XmlValue[] | { [key: string]: XmlValue }

/**
 * Tells whether a value is a map.
 *
 * @param value - The value.
 * @returns True for a map.
 */
function isMap (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Writes a value as the text of an element or an attribute.
 *
 * @param value - The value.
 * @returns Its text, JSON for a value that is not a scalar.
 */
function textOf (value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? `${value}` : JSON.stringify(value ?? '')
}

/**
 * Lists the element children of a node.
 *
 * @param node - The node.
 * @returns Its children that are elements, in order.
 */
function elementsOf (node: Node): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => child.nodeType === ELEMENT_NODE)
}

/**
 * Gives the text directly held by an element, without the text of its children.
 *
 * @param element - The element.
 * @returns Its own text, trimmed.
 */
function ownText (element: Element): string {
  return Array.from(element.childNodes).filter(child => child.nodeType === TEXT_NODE).map(child => child.nodeValue ?? '').join('').trim()
}

/**
 * Reads an element as a value: its text when it holds neither attributes nor children, else a map of
 * its attributes, its children (siblings sharing a name making a list) and its own text.
 *
 * @param element - The element.
 * @returns Its value.
 */
function valueOf (element: Element): XmlValue {
  const children = elementsOf(element)
  if (children.length === 0 && element.attributes.length === 0) {
    return element.textContent ?? ''
  }

  const value: Record<string, XmlValue> = {}
  for (const attribute of Array.from(element.attributes)) {
    value[`@${attribute.name}`] = attribute.value
  }
  for (const name of new Set(children.map(child => child.tagName))) {
    const named = children.filter(child => child.tagName === name)
    value[name] = named.length === 1 ? valueOf(named[0]) : named.map(valueOf)
  }
  const text = ownText(element)
  if (text !== '') {
    value[TEXT_KEY] = text
  }
  return value
}

/**
 * Parses an XML text.
 *
 * @param text - The XML text.
 * @param label - Names the file in errors.
 * @returns The document.
 */
function parse (text: string, label: string): Document {
  try {
    return new DOMParser({ onError: onErrorStopParsing }).parseFromString(text, 'text/xml')
  } catch (error) {
    throw new Error(`${label} is not valid XML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, { cause: error })
  }
}

/**
 * Gives the document of an element.
 *
 * @param element - The element.
 * @returns Its document.
 */
function documentOf (element: Element): Document {
  if (!element.ownerDocument) {
    throw new Error(`${element.tagName} belongs to no document`)
  }
  return element.ownerDocument
}

/**
 * Gives the indentation of the line an element starts.
 *
 * @param element - The element.
 * @returns The blanks before it on its line.
 */
function indentOf (element: Element): string {
  const before = element.previousSibling
  return before?.nodeType === TEXT_NODE ? /[^\S\n]*$/.exec(before.nodeValue ?? '')?.[0] ?? '' : ''
}

/**
 * Gives the indentation of the children of an element: the one of its children, else its own one
 * level deeper.
 *
 * @param parent - The element.
 * @returns The blanks before a child.
 */
function childIndentOf (parent: Element): string {
  const child = elementsOf(parent)[0]
  return child ? indentOf(child) : `${indentOf(parent)}${DEFAULT_INDENT}`
}

/**
 * Adds an element to a parent on a line of its own, after a sibling or at the end.
 *
 * @param parent - The parent.
 * @param child - The element to add.
 * @param after - The sibling it follows, null for the end.
 */
function insertChild (parent: Element, child: Element, after: Element | null): void {
  const document = documentOf(parent)
  const indent = childIndentOf(parent)
  const reference = after ? after.nextSibling : parent.lastChild?.nodeType === TEXT_NODE && elementsOf(parent).length > 0 ? parent.lastChild : null
  if (!after && elementsOf(parent).length === 0) {
    parent.appendChild(document.createTextNode(`\n${indent}`))
    parent.appendChild(child)
    parent.appendChild(document.createTextNode(`\n${indentOf(parent)}`))
    return
  }
  parent.insertBefore(document.createTextNode(`\n${indent}`), reference)
  parent.insertBefore(child, reference)
}

/**
 * Removes an element with the blanks before it.
 *
 * @param element - The element.
 */
function removeElement (element: Element): void {
  const before = element.previousSibling
  if (before?.nodeType === TEXT_NODE && (before.nodeValue ?? '').trim() === '') {
    before.parentNode?.removeChild(before)
  }
  element.parentNode?.removeChild(element)
}

/**
 * Gives an element a value: a text replacing its content, or a map setting its attributes, its
 * children and its own text, the keys missing from the map being removed.
 *
 * @param element - The element.
 * @param value - The new value.
 */
function setValue (element: Element, value: unknown): void {
  if (!isMap(value)) {
    element.textContent = textOf(value)
    return
  }

  for (const attribute of Array.from(element.attributes)) {
    if (!Object.hasOwn(value, `@${attribute.name}`)) {
      element.removeAttribute(attribute.name)
    }
  }
  for (const name of new Set(elementsOf(element).map(child => child.tagName))) {
    if (!Object.hasOwn(value, name)) {
      setChildren(element, name, undefined)
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    setKey(element, key, entry)
  }
}

/**
 * Replaces the children of an element sharing a name by the elements of a value, updating those in
 * place and adding or removing the others.
 *
 * @param parent - The element.
 * @param name - The name of the children.
 * @param value - Their value, a list for several, `undefined` to remove them.
 */
function setChildren (parent: Element, name: string, value: unknown): void {
  const existing = elementsOf(parent).filter(child => child.tagName === name)
  const wanted = value === undefined ? [] : Array.isArray(value) ? value : [value]
  wanted.forEach((entry, index) => {
    if (existing[index]) {
      setValue(existing[index], entry)
      return
    }
    const child = documentOf(parent).createElement(name)
    insertChild(parent, child, existing.at(-1) ?? null)
    existing.push(child)
    setValue(child, entry)
  })
  existing.slice(wanted.length).forEach(removeElement)
}

/**
 * Sets one key of an element: an attribute (`@name`), its own text (`#text`) or its children.
 *
 * @param element - The element.
 * @param key - The key.
 * @param value - The new value, `undefined` to remove the key.
 */
function setKey (element: Element, key: string, value: unknown): void {
  if (key.startsWith('@')) {
    if (value === undefined) {
      element.removeAttribute(key.slice(1))
    } else {
      element.setAttribute(key.slice(1), textOf(value))
    }
  } else if (key === TEXT_KEY) {
    const texts = Array.from(element.childNodes).filter(child => child.nodeType === TEXT_NODE && (child.nodeValue ?? '').trim() !== '')
    texts.forEach(text => element.removeChild(text))
    if (value !== undefined) {
      element.insertBefore(documentOf(element).createTextNode(textOf(value)), element.firstChild)
    }
  } else {
    setChildren(element, key, value)
  }
}

/**
 * Applies a change to a document, creating the elements missing on the way to the key.
 *
 * @param document - The document.
 * @param change - The key, from the root element, and its new value.
 */
function applyChange (document: Document, change: KeyChange): void {
  const [rootName, ...keys] = change.path
  const current = document.documentElement
  if (keys.length === 0 && change.value === undefined) {
    if (current?.tagName === rootName) {
      document.removeChild(current)
    }
    return
  }
  let element: Element
  if (current?.tagName === rootName) {
    element = current
  } else {
    if (change.value === undefined) {
      return
    }
    element = document.createElement(rootName)
    if (current) {
      document.replaceChild(element, current)
    } else {
      document.appendChild(element)
    }
  }
  if (keys.length === 0) {
    setValue(element, change.value)
    return
  }

  for (const key of keys.slice(0, -1)) {
    const child = elementsOf(element).find(candidate => candidate.tagName === key)
    if (!child) {
      if (change.value === undefined) {
        return
      }
      const created = document.createElement(key)
      insertChild(element, created, null)
      element = created
    } else {
      element = child
    }
  }
  setKey(element, keys[keys.length - 1], change.value)
}

/** XML files, their root element being the first key of their map. */
export const XML_FORMAT: ConfigFormat = {
  read (text, label) {
    if (text.trim() === '') {
      return {}
    }
    const root = parse(text, label).documentElement
    return root ? { [root.tagName]: valueOf(root) } : {}
  },
  /**
   * Changes the keys of an XML file in place, keeping its declaration, comments and layout.
   *
   * @param baseText - The XML text.
   * @param changes - The new value of each key, `undefined` to remove it.
   * @returns The new text.
   */
  write (baseText, changes) {
    const document = baseText.trim() === '' ? new DOMImplementation().createDocument(null, '') : parse(baseText, 'the file')
    for (const change of changes) {
      applyChange(document, change)
    }
    const text = new XMLSerializer().serializeToString(document)
    return baseText.endsWith('\n') && !text.endsWith('\n') ? `${text}\n` : text
  }
}
