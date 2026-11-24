import { ref, shallowRef } from "vue";

/** A page shown in a frame. */
export interface Embed {
  url: string;
  title: string;
}

/** A page kept in a frame, with how many times it was reloaded. */
export interface OpenedEmbed extends Embed {
  reloads: number;
}

/** The embedded page on screen and the element its frame covers. */
export interface ShownEmbed {
  url: string;
  element: HTMLElement;
}

/** Keeps every opened embedded page loaded, a view choosing which one shows and where. */
class EmbedStore {
  /** The pages opened since the interface loaded, each kept in its own frame. */
  embeds = ref<OpenedEmbed[]>([]);

  /** The page on screen, or null when no view shows one. */
  shown = shallowRef<ShownEmbed | null>(null);

  /**
   * Shows a page over an element, opening its frame the first time.
   * @param embed The page to show.
   * @param element The element the frame covers.
   */
  show(embed: Embed, element: HTMLElement): void {
    if (!this.embeds.value.some((item) => item.url === embed.url)) {
      this.embeds.value.push({ ...embed, reloads: 0 });
    }
    this.shown.value = { url: embed.url, element };
  }

  /**
   * Reloads the frame of a page from its address.
   * @param url The address of the page.
   */
  reload(url: string): void {
    const embed = this.embeds.value.find((item) => item.url === url);
    if (embed) {
      embed.reloads += 1;
    }
  }

  /**
   * Hides the page shown over an element, its frame staying loaded.
   * @param element The element the frame covers.
   */
  hide(element: HTMLElement): void {
    if (this.shown.value?.element === element) {
      this.shown.value = null;
    }
  }
}

export default new EmbedStore();
