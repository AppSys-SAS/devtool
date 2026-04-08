import { ref } from "vue";

class BookmarkStore {
  slugs = ref<string[]>([]);

  constructor() {
    try {
      const raw = window.localStorage.getItem("bookmarks");
      if (raw) {
        this.slugs.value = JSON.parse(raw) as string[];
      }
    } catch {
      this.slugs.value = [];
    }
  }

  toggleBookmark(slug: string): void {
    if (this.slugs.value.includes(slug)) {
      this.slugs.value = this.slugs.value.filter((item) => item !== slug);
    } else {
      this.slugs.value.push(slug);
    }

    window.localStorage.setItem("bookmarks", JSON.stringify(this.slugs.value));
  }
}

export default new BookmarkStore();
